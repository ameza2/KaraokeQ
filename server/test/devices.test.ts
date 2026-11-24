import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeviceRegistry, deviceFileName } from "../src/devices.ts";

let dir: string;
let now: number;
before(() => void (dir = mkdtempSync(path.join(tmpdir(), "karaoke-devices-"))));
after(() => rmSync(dir, { recursive: true, force: true }));

const make = (sub: string) => {
  now = Date.parse("2026-11-23T12:00:00Z");
  const d = path.join(dir, sub);
  return { d, reg: new DeviceRegistry(d, { now: () => now, recheckMs: 0, flushMs: 0 }) };
};
const fileOf = (d: string, key: string) => path.join(d, "devices", deviceFileName(key));
const read = (d: string, key: string) => JSON.parse(readFileSync(fileOf(d, key), "utf8"));

describe("DeviceRegistry", () => {
  it("tracks a device's first and last time seen, connections, names, rooms and browsers", async () => {
    const { d, reg } = make("activity");
    reg.connect("s1", "10.1.0.1", "Mozilla/5.0 (iPhone)");
    now += 60_000;
    reg.join("s1", { name: "Ana", singerId: "a1", code: "ABCD", role: "host" });
    now += 60_000;
    reg.disconnect("s1");
    reg.connect("s2", "10.1.0.1", "Mozilla/5.0 (iPhone)");
    reg.join("s2", { name: "Ana", singerId: "a1", code: "ABCD", role: "host" });
    await reg.flush();

    const r = read(d, "10.1.0.1");
    assert.equal(r.firstSeen, "2026-11-23T12:00:00.000Z");
    assert.equal(r.lastSeen, "2026-11-23T12:02:00.000Z");
    assert.equal(r.connections, 2);
    assert.deepEqual(r.names.map((n: { name: string }) => n.name), ["Ana"]);
    assert.deepEqual([r.rooms[0].code, r.rooms[0].role, r.rooms[0].joins], ["ABCD", "host", 2]);
    assert.equal(r.userAgents.length, 1);
    assert.equal(r.status, "ok");
  });

  it("lists devices that are connected now, with who they are in which room", () => {
    const { reg } = make("active");
    reg.connect("s1", "10.1.0.2", "ua");
    reg.join("s1", { name: "Ben", singerId: "b1", code: "WXYZ", role: "singer" });
    reg.connect("s2", "10.1.0.3", "ua");
    assert.deepEqual(reg.active().map((a) => a.address).sort(), ["10.1.0.2", "10.1.0.3"]);
    assert.deepEqual(reg.active().find((a) => a.address === "10.1.0.2")!.people, [{ name: "Ben", room: "WXYZ", role: "singer" }]);
    reg.disconnect("s1");
    assert.deepEqual(reg.active().map((a) => a.address), ["10.1.0.3"]);
  });

  it("keeps wrong guesses, timeouts and blocks, and the admin's note, and survives a restart", async () => {
    const { d, reg } = make("history");
    reg.recordFailure("10.1.0.4", "login");
    reg.recordFailure("10.1.0.4", "login");
    reg.recordFailure("10.1.0.4", "code");
    reg.recordTimeout("10.1.0.4", "login", now + 300_000);
    assert.equal(reg.block("10.1.0.4", "admin", "admin", "kept spamming"), true);
    assert.equal(reg.block("10.1.0.4", "admin", "admin"), false);
    await reg.flush();

    const again = new DeviceRegistry(d, { now: () => now, recheckMs: 0, flushMs: 0 });
    const r = again.get("10.1.0.4")!;
    assert.deepEqual(r.failures, { login: 2, code: 1 });
    assert.equal(r.note, "kept spamming");
    assert.deepEqual(r.bans.map((b) => [b.kind, b.by]), [["temporary", "auto"], ["permanent", "admin"]]);
    assert.equal(again.isBlocked("10.1.0.4"), true);

    assert.equal(again.unblock("10.1.0.4"), true);
    assert.equal(again.isBlocked("10.1.0.4"), false);
    assert.ok(again.get("10.1.0.4")!.bans.every((b) => b.liftedAt), "the history shows the bans were lifted");
    assert.equal(again.get("10.1.0.4")!.failures.login, 2, "unblocking keeps the record");
    assert.equal(existsSync(fileOf(d, "10.1.0.4")), true, "a device file is never deleted");
  });

  it("finds devices by address, name, note or room code, most recent first", () => {
    const { reg } = make("search");
    reg.connect("s1", "10.1.0.5", "ua");
    reg.join("s1", { name: "Chloe", singerId: "c1", code: "QRST", role: "singer" });
    now += 1000;
    reg.connect("s2", "10.1.0.6", "ua");
    reg.setNote("10.1.0.6", "the loud one");
    assert.deepEqual(reg.recent(10).map((r) => r.address), ["10.1.0.6", "10.1.0.5"]);
    assert.deepEqual(reg.recent(10, "chlo").map((r) => r.address), ["10.1.0.5"]);
    assert.deepEqual(reg.recent(10, "LOUD").map((r) => r.address), ["10.1.0.6"]);
    assert.deepEqual(reg.recent(10, "qrst").map((r) => r.address), ["10.1.0.5"]);
    assert.deepEqual(reg.recent(10, "10.1.0.6").map((r) => r.address), ["10.1.0.6"]);
  });

  it("caps its lists so a file stays small", async () => {
    const { d, reg } = make("caps");
    reg.connect("s1", "10.1.0.7", "ua");
    for (let i = 0; i < 80; i++) reg.join("s1", { name: `n${i}`, singerId: `id${i}`, code: `R${i}`, role: "singer" });
    await reg.flush();
    const r = read(d, "10.1.0.7");
    assert.equal(r.names.length, 50);
    assert.equal(r.rooms.length, 80);
    assert.equal(r.names.at(-1).name, "n79", "the newest entries are kept");
  });

  it("imports the earlier blocklist.json once and keeps the old file", async () => {
    now = Date.now();
    const d = path.join(dir, "migrate");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "blocklist.json"), JSON.stringify({ blocked: [{ key: "10.1.0.8", since: "2026-11-01T10:00:00.000Z", scope: "login" }] }));
    const reg = new DeviceRegistry(d, { recheckMs: 0, flushMs: 0 });
    assert.equal(reg.isBlocked("10.1.0.8"), true);
    assert.equal(reg.get("10.1.0.8")!.blocked!.at, "2026-11-01T10:00:00.000Z");
    await reg.flush();
    assert.equal(existsSync(path.join(d, "blocklist.json")), false);
    assert.equal(existsSync(path.join(d, "blocklist.json.migrated")), true);
    assert.equal(readdirSync(path.join(d, "devices")).includes("10.1.0.8.json"), true);
  });

  it("writes IPv6 addresses to safe file names", () => {
    assert.equal(deviceFileName("fe80::1"), "fe80__1.json");
    assert.equal(deviceFileName("?"), "_.json");
  });

  it("picks up a device file added by hand, and forgets a file deleted by hand", async () => {
    const { d, reg } = make("hand");
    reg.connect("s1", "10.1.0.9", "ua");
    await reg.flush();
    const record = read(d, "10.1.0.9");
    writeFileSync(fileOf(d, "10.1.0.50"), JSON.stringify({ ...record, address: "10.1.0.50", status: "blocked", blocked: { at: "2026-11-02T00:00:00Z", scope: "admin", by: "admin" } }));
    assert.equal(reg.isBlocked("10.1.0.50"), true, "a file dropped in the folder blocks that device");
    rmSync(fileOf(d, "10.1.0.50"));
    assert.equal(reg.isBlocked("10.1.0.50"), false, "deleting the file by hand lets it back in");
  });
});
