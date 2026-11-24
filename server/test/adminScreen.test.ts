import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, createRoom, startServer, until, type TestServer } from "./harness.ts";

let server: TestServer;
let cookie = "";
before(async () => {
  server = await startServer();
  const json = { "content-type": "application/json" };
  const res = await fetch(`${server.url}/api/admin/login`, { method: "POST", headers: json, body: JSON.stringify({ username: "Administrator", password: "password" }) });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  await fetch(`${server.url}/api/admin/password`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ current: "password", next: "a-better-one" }) });
});
after(async () => void (await server.stop()));

const call = (method: string, p: string) => fetch(`${server.url}/api/admin${p}`, { method, headers: { cookie } });
type Report = { room: { screenCode: string; screenConnected: boolean } };

describe("admin screen controls", () => {
  it("shows the screen code and needs a session", async () => {
    const { code } = await createRoom(server.url);
    assert.equal((await fetch(`${server.url}/api/admin/rooms/${code}/screen-code`, { method: "POST" })).status, 401);
    const rooms = (await (await call("GET", "/rooms"))!.json()) as { rooms: { code: string; screenCode: string }[] };
    assert.match(rooms.rooms.find((r) => r.code === code)!.screenCode, /^[A-HJ-NP-Z2-9]{6}$/);
  });

  it("resets the code for future screens without touching the screen that is playing", async () => {
    const { code, hostToken } = await createRoom(server.url);
    const host = new Client(server.url, "h1");
    await host.join(code, hostToken);
    const tv = new Client(server.url, "tv1");
    const joined = (await tv.joinScreen(code)) as { ok: true; screenCode: string };
    const old = joined.screenCode;

    const reset = (await (await call("POST", `/rooms/${code}/screen-code`)).json()) as Report;
    assert.notEqual(reset.room.screenCode, old);
    assert.equal(tv.socket.connected, true);
    assert.equal(reset.room.screenConnected, true);

    const stale = await new Client(server.url, "tv2").joinScreen(code, "x.local", { screenCode: old });
    assert.equal(stale.ok, false, "the old code no longer works");
    assert.equal((await new Client(server.url, "tv3").joinScreen(code, "x.local", { screenCode: reset.room.screenCode })).ok, true);
  });

  it("stops the screen that is playing, and says so when there is none", async () => {
    const { code, hostToken } = await createRoom(server.url);
    const host = new Client(server.url, "h2");
    await host.join(code, hostToken);
    assert.equal((await call("DELETE", `/rooms/${code}/screen`)).status, 400);

    const tv = new Client(server.url, "tv-stop");
    await tv.joinScreen(code);
    await host.waitState((s) => s.screens === 1);
    let closed = "";
    tv.socket.on("room:closed", (c) => (closed = c.message));
    const res = await call("DELETE", `/rooms/${code}/screen`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Report).room.screenConnected, false);
    await until(() => !tv.socket.connected, "the screen to be hung up");
    assert.match(closed, /admin stopped/);
    await host.waitState((s) => s.screens === 0);
  });
});
