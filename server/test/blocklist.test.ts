import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Blocklist, deviceKey } from "../src/blocklist.ts";

let dir: string;
let now: number;
const clock = () => now;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "karaoke-blocklist-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const make = (sub: string) => {
  const d = path.join(dir, sub);
  now = 1_000_000;
  return { dir: d, list: new Blocklist(d, { now: clock, recheckMs: 0 }) };
};

describe("Blocklist", () => {
  it("lets a device guess four times, then bans it for five minutes on the fifth miss", () => {
    const { list } = make("temp");
    for (let i = 0; i < 4; i++) assert.equal(list.fail("code", "10.0.0.5").blocked, false);
    const fifth = list.fail("code", "10.0.0.5");
    assert.deepEqual(fifth, { blocked: true, permanent: false, retryAfterMs: 5 * 60e3 });
    assert.equal(list.status("code", "10.0.0.5").blocked, true);
    now += 5 * 60e3 + 1;
    assert.equal(list.status("code", "10.0.0.5").blocked, false);
  });

  it("does not count attempts made while banned, and starts another ban after the next miss", () => {
    const { list } = make("rebans");
    for (let i = 0; i < 5; i++) list.fail("code", "10.0.0.6");
    for (let i = 0; i < 20; i++) list.fail("code", "10.0.0.6"); // ignored: already banned
    assert.equal(list.list().length, 0);
    now += 5 * 60e3 + 1;
    assert.equal(list.fail("code", "10.0.0.6").blocked, true); // 6th miss, banned again
  });

  it("clears the run on a success", () => {
    const { list } = make("reset");
    for (let i = 0; i < 4; i++) list.fail("code", "10.0.0.7");
    list.succeed("code", "10.0.0.7");
    for (let i = 0; i < 4; i++) assert.equal(list.fail("code", "10.0.0.7").blocked, false);
  });

  it("keeps scopes and devices apart for temporary bans", () => {
    const { list } = make("scopes");
    for (let i = 0; i < 5; i++) list.fail("login", "10.0.0.8");
    assert.equal(list.status("login", "10.0.0.8").blocked, true);
    assert.equal(list.status("code", "10.0.0.8").blocked, false);
    assert.equal(list.status("login", "10.0.0.9").blocked, false);
  });

  it("bans for good at ten misses in a row, in every scope, and writes the device file", async () => {
    const { dir: d, list } = make("perm");
    for (let i = 0; i < 10; i++) {
      list.fail("code", "10.0.0.10");
      now += 5 * 60e3 + 1; // wait out each temporary ban
    }
    assert.deepEqual(list.status("code", "::ffff:10.0.0.10"), { blocked: true, permanent: true });
    assert.deepEqual(list.status("login", "10.0.0.10"), { blocked: true, permanent: true });
    await new Promise((r) => setTimeout(r, 50));
    const saved = JSON.parse(readFileSync(path.join(d, "devices", "10.0.0.10.json"), "utf8")) as { status: string; blocked: { scope: string; by: string }; failures: Record<string, number> };
    assert.equal(saved.status, "blocked");
    assert.deepEqual([saved.blocked.scope, saved.blocked.by, saved.failures.code], ["code", "auto", 10]);
    now += 24 * 3600e3;
    assert.equal(list.status("code", "10.0.0.10").blocked, true, "a permanent ban never expires");
  });

  it("loads permanent bans from the device files after a restart and lets a device back in when its status is set to ok", async () => {
    const { dir: d, list } = make("restart");
    for (let i = 0; i < 10; i++) {
      list.fail("login", "10.0.0.11");
      now += 5 * 60e3 + 1;
    }
    await new Promise((r) => setTimeout(r, 50));
    const again = new Blocklist(d, { now: clock, recheckMs: 0 });
    assert.equal(again.status("login", "10.0.0.11").blocked, true);

    const file = path.join(d, "devices", "10.0.0.11.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, status: "ok", blocked: null }, null, 2));
    assert.equal(again.status("login", "10.0.0.11").blocked, false, "editing the file takes effect without a restart");
  });

  it("keeps the list in memory when the file is damaged", async () => {
    const { dir: d, list } = make("damaged");
    for (let i = 0; i < 10; i++) {
      list.fail("login", "10.0.0.12");
      now += 5 * 60e3 + 1;
    }
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(path.join(d, "devices", "10.0.0.12.json"), "{not json");
    assert.equal(list.status("login", "10.0.0.12").blocked, true);
  });

  it("keeps a timeout across a restart, with the run of wrong guesses behind it", async () => {
    const { dir: d, list } = make("timeout-restart");
    for (let i = 0; i < 5; i++) list.fail("code", "10.0.0.20");
    now += 60e3;
    await new Promise((r) => setTimeout(r, 50));
    const again = new Blocklist(d, { now: clock, recheckMs: 0 });
    const status = again.status("code", "10.0.0.20");
    assert.deepEqual(status, { blocked: true, permanent: false, retryAfterMs: 4 * 60e3 });
    assert.equal(again.temporary()[0]?.fails, 5);
    assert.equal(again.fail("code", "10.0.0.20").blocked, true, "wrong guesses made during the timeout are ignored");
    now += 4 * 60e3 + 1;
    assert.equal(again.fail("code", "10.0.0.20").blocked, true, "the run of five survived too: the sixth miss bans again");
  });

  it("ends a timeout when its entry is edited out of the device file, and starts one from an edit", async () => {
    const { dir: d, list } = make("timeout-edit");
    for (let i = 0; i < 5; i++) list.fail("login", "10.0.0.21");
    await new Promise((r) => setTimeout(r, 50));
    const file = path.join(d, "devices", "10.0.0.21.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as { lockouts: Record<string, { fails: number; until: string | null }> };
    assert.equal(list.status("login", "10.0.0.21").blocked, true);

    writeFileSync(file, JSON.stringify({ ...record, lockouts: {} }, null, 2));
    assert.equal(list.status("login", "10.0.0.21").blocked, false, "deleting the scope's entry lifts the timeout");
    for (let i = 0; i < 4; i++) assert.equal(list.fail("login", "10.0.0.21").blocked, false, "and the count starts again");

    await list.devices.flush(); // an edit made while the server still has an unsaved change to the same device would lose to it
    writeFileSync(file, JSON.stringify({ ...record, lockouts: { login: { fails: 5, until: new Date(now + 600e3).toISOString(), last: new Date(now).toISOString() } } }, null, 2));
    assert.deepEqual(list.status("login", "10.0.0.21"), { blocked: true, permanent: false, retryAfterMs: 600e3 }, "a future `until` written by hand bans the device");
    writeFileSync(file, JSON.stringify({ ...record, lockouts: { login: { fails: 5, until: new Date(now - 1000).toISOString(), last: new Date(now).toISOString() } } }, null, 2));
    assert.equal(list.status("login", "10.0.0.21").blocked, false, "a past `until` lifts it");
  });

  it("forgets a run of failures after an hour without a new one", () => {
    const { list } = make("decay");
    for (let i = 0; i < 4; i++) list.fail("code", "10.0.0.13");
    now += 61 * 60e3;
    for (let i = 0; i < 4; i++) assert.equal(list.fail("code", "10.0.0.13").blocked, false);
    assert.equal(list.fail("code", "10.0.0.13").blocked, true, "five within the hour still ban");
  });

  it("does not forget failures because a correct guess happened elsewhere", () => {
    const { list } = make("scope-only");
    for (let i = 0; i < 4; i++) list.fail("code", "10.0.0.14");
    list.succeed("login", "10.0.0.14");
    assert.equal(list.fail("code", "10.0.0.14").blocked, true);
  });

  it("treats IPv4-mapped IPv6 addresses as the plain address", () => {
    assert.equal(deviceKey("::ffff:192.168.1.5"), "192.168.1.5");
    assert.equal(deviceKey(undefined), "?");
  });
});
