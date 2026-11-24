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

  it("bans for good at ten misses in a row, in every scope, and writes the file", async () => {
    const { dir: d, list } = make("perm");
    for (let i = 0; i < 10; i++) {
      list.fail("code", "10.0.0.10");
      now += 5 * 60e3 + 1; // wait out each temporary ban
    }
    assert.deepEqual(list.status("code", "::ffff:10.0.0.10"), { blocked: true, permanent: true });
    assert.deepEqual(list.status("login", "10.0.0.10"), { blocked: true, permanent: true });
    await new Promise((r) => setTimeout(r, 50));
    const saved = JSON.parse(readFileSync(path.join(d, "blocklist.json"), "utf8")) as { blocked: { key: string }[] };
    assert.deepEqual(saved.blocked.map((e) => e.key), ["10.0.0.10"]);
    now += 24 * 3600e3;
    assert.equal(list.status("code", "10.0.0.10").blocked, true, "a permanent ban never expires");
  });

  it("loads permanent bans from the file after a restart and lets a device back in when its entry is removed", async () => {
    const { dir: d, list } = make("restart");
    for (let i = 0; i < 10; i++) {
      list.fail("login", "10.0.0.11");
      now += 5 * 60e3 + 1;
    }
    await new Promise((r) => setTimeout(r, 50));
    const again = new Blocklist(d, { now: clock, recheckMs: 0 });
    assert.equal(again.status("login", "10.0.0.11").blocked, true);

    writeFileSync(path.join(d, "blocklist.json"), JSON.stringify({ blocked: [] }));
    assert.equal(again.status("login", "10.0.0.11").blocked, false, "removing the entry takes effect without a restart");
  });

  it("keeps the list in memory when the file is damaged", async () => {
    const { dir: d, list } = make("damaged");
    for (let i = 0; i < 10; i++) {
      list.fail("login", "10.0.0.12");
      now += 5 * 60e3 + 1;
    }
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(path.join(d, "blocklist.json"), "{not json");
    assert.equal(list.status("login", "10.0.0.12").blocked, true);
  });

  it("treats IPv4-mapped IPv6 addresses as the plain address", () => {
    assert.equal(deviceKey("::ffff:192.168.1.5"), "192.168.1.5");
    assert.equal(deviceKey(undefined), "?");
  });
});
