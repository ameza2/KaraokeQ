import { existsSync, readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DevicesReport } from "@karaoke/shared";
import { Client, createRoom, startServer, wait, type TestServer } from "./harness.ts";

let server: TestServer;
let cookie = "";
let dataDir = "";
before(async () => {
  server = await startServer();
  dataDir = server.dataDir;
  const json = { "content-type": "application/json" };
  const res = await fetch(`${server.url}/api/admin/login`, { method: "POST", headers: json, body: JSON.stringify({ username: "Administrator", password: "password" }) });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const changed = await fetch(`${server.url}/api/admin/password`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ current: "password", next: "a-better-one" }) });
  cookie = (changed.headers.get("set-cookie") ?? "").split(";")[0]!;
});
after(async () => void (await server.stop()));

const call = (method: string, p: string, body?: unknown) =>
  fetch(`${server.url}/api/admin${p}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
const report = async (q = "") => (await (await call("GET", `/devices?q=${encodeURIComponent(q)}`)).json()) as DevicesReport;

describe("admin devices", () => {
  it("needs a session", async () => {
    assert.equal((await fetch(`${server.url}/api/admin/devices`)).status, 401);
  });

  it("shows who is connected, in which room, and remembers them after they leave", async () => {
    const { code, hostToken } = await createRoom(server.url);
    const ana = new Client(server.url, "ana-id", "Ana");
    await ana.join(code, hostToken);

    const live = await report();
    const entry = live.active.find((a) => a.people.some((p) => p.name === "Ana"));
    assert.ok(entry, "Ana is listed as connected");
    assert.deepEqual(entry!.people[0], { name: "Ana", room: code, role: "host" });

    ana.close();
    await wait(200);
    const after = await report("ana");
    const record = after.recent.find((r) => r.address === entry!.address)!;
    assert.ok(record, "found by name");
    assert.equal(after.active.some((a) => a.address === entry!.address), false, "no longer connected");
    assert.deepEqual([record.names[0]?.name, record.rooms[0]?.code, record.connections >= 1], ["Ana", code, true]);
    assert.equal(after.recent.length, (await report(code)).recent.length, "found by room code too");
  });

  it("keeps a block and its note in the device file, and shows it in the blocked list", async () => {
    const add = await call("POST", "/blocklist", { address: "203.0.113.9", note: "kept spamming" });
    assert.equal(add.status, 200);
    const r = await report();
    const blocked = r.blocked.find((b) => b.address === "203.0.113.9")!;
    assert.deepEqual([blocked.status, blocked.blocked?.by, blocked.note], ["blocked", "admin", "kept spamming"]);

    await wait(100);
    const file = `${dataDir}/devices/203.0.113.9.json`;
    assert.equal(existsSync(file), true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "blocked");

    assert.equal((await call("DELETE", "/blocklist/203.0.113.9")).status, 200);
    const lifted = (await report("203.0.113.9")).recent[0]!;
    assert.deepEqual([lifted.status, lifted.bans[0]?.liftedAt !== null], ["ok", true], "the record stays, with its history");
  });

  it("saves a note, and refuses one for a device it has never seen", async () => {
    await call("POST", "/blocklist", { address: "203.0.113.10" });
    assert.equal((await call("PUT", "/devices/203.0.113.10/note", { note: "neighbour" })).status, 200);
    assert.equal((await report("neighbour")).recent[0]?.address, "203.0.113.10");
    assert.equal((await call("PUT", "/devices/203.0.113.99/note", { note: "x" })).status, 404);
  });
});
