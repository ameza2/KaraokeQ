import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, createRoom, startServer, until, wait, type TestServer } from "./harness.ts";

let server: TestServer;
const clients: Client[] = [];
const newClient = (id: string) => {
  const c = new Client(server.url, id);
  clients.push(c);
  return c;
};
const emitRaw = (c: Client, ev: string, ...args: unknown[]) => (c.socket.emit as (...a: unknown[]) => void)(ev, ...args);

before(async () => {
  server = await startServer();
});
after(async () => {
  clients.forEach((c) => c.close());
  await server.stop();
});

const alive = async () => (await fetch(`${server.url}/api/info`)).status === 200;

/** Every event in the contract, with the payload a client would normally send. */
const EVENTS = [
  "room:join", "singer:rename", "queue:add", "queue:remove", "queue:move", "history:get", "history:replay",
  "playback:skip", "playback:rewind", "playback:seek", "playback:pause", "playback:resume",
  "host:transfer", "host:claim", "settings:update", "cast:pair", "cast:unpair",
  "screen:join", "screen:progress", "screen:event",
];
const GARBAGE: unknown[] = [null, "text", 42, [], [1, 2], { video: null, itemId: {}, seconds: "x", name: [], code: {}, e: 1 }];

describe("malformed socket events", () => {
  it("never crash the server, whether or not the socket has joined a room", async () => {
    const { code, hostToken } = await createRoom(server.url);
    const stranger = newClient("stranger");
    const host = newClient("host-garbage");
    await host.join(code, hostToken);
    const screen = newClient("screen-garbage");
    await screen.joinScreen(code);

    for (const c of [stranger, host, screen]) {
      for (const ev of EVENTS) {
        for (const bad of GARBAGE) {
          emitRaw(c, ev, bad);
          emitRaw(c, ev, bad, () => {});
        }
        emitRaw(c, ev); // no payload and no ack at all
      }
    }
    await wait(500);
    assert.ok(await alive(), "the server is still answering");
    // and the rooms still work for a normal person afterwards
    const guest = newClient("guest-after-garbage");
    assert.equal((await guest.join(code)).ok, true);
  });

  it("answers an acked request with an error instead of leaving the caller waiting", async () => {
    const { code } = await createRoom(server.url);
    const c = newClient("asker");
    await c.join(code);
    for (const ev of ["queue:add", "history:replay", "host:transfer"] as const) {
      const r = await Promise.race([c.ask(ev, null), wait(2000).then(() => "timeout" as const)]);
      assert.notEqual(r, "timeout", `${ev} must answer`);
      assert.equal((r as { ok: boolean }).ok, false);
    }
  });

  it("drops a join that has no way to be answered", async () => {
    const { code } = await createRoom(server.url);
    const c = newClient("no-ack");
    emitRaw(c, "room:join", { code, singerId: "no-ack", name: "No ack" });
    await wait(300);
    assert.ok(await alive());
  });
});

describe("one room per socket", () => {
  it("leaves the first room when the socket joins another", async () => {
    const a = await createRoom(server.url);
    const b = await createRoom(server.url);
    const watcher = newClient("watcher");
    await watcher.join(a.code);
    const mover = newClient("mover");
    await mover.join(a.code);
    await watcher.waitState((s) => s.singers.some((x) => x.id === "mover" && x.online), "mover online in the first room");
    await mover.join(b.code);
    await watcher.waitState((s) => s.singers.some((x) => x.id === "mover" && !x.online), "mover offline in the first room");
  });
});

describe("room size", () => {
  it("refuses new people once a room has 100", async () => {
    const { code } = await createRoom(server.url);
    const pool = [newClient("pool-a"), newClient("pool-b")];
    // a socket joining under a new id leaves its previous one, but the singer record stays, so ids pile up
    for (let i = 0; i < 100; i++) {
      const r = await pool[i % 2].socket.emitWithAck("room:join", { code, singerId: `p${i}`, name: `P${i}` });
      assert.equal(r.ok, true, `person ${i + 1} joins`);
    }
    const extra = await pool[0].socket.emitWithAck("room:join", { code, singerId: "one-too-many", name: "Extra" });
    assert.equal(extra.ok, false);
    // someone already in the room can still come back
    const back = await pool[1].socket.emitWithAck("room:join", { code, singerId: "p3", name: "P3" });
    assert.equal(back.ok, true);
    void until;
  });
});

describe("room creation limits", () => {
  it("rate-limits creation per address and caps the rooms on the server", async () => {
    const small = await startServer({ KARAOKE_ROOM_CREATE_PER_MIN: "3", KARAOKE_MAX_ROOMS: "100" });
    try {
      const post = () => fetch(`${small.url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      for (let i = 0; i < 3; i++) assert.equal((await post()).status, 200);
      assert.equal((await post()).status, 429);
    } finally {
      await small.stop();
    }
    const capped = await startServer({ KARAOKE_MAX_ROOMS: "2" });
    try {
      const post = () => fetch(`${capped.url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal((await post()).status, 200);
      assert.equal((await post()).status, 200);
      assert.equal((await post()).status, 503);
    } finally {
      await capped.stop();
    }
  });
});

describe("seeking on the browser screen", () => {
  it("ignores a stale report from before the seek instead of bouncing the bar back", async () => {
    const { code, hostToken } = await createRoom(server.url);
    const host = newClient("seek-host");
    await host.join(code, hostToken);
    const tv = newClient("seek-tv");
    await tv.joinScreen(code);
    await host.add({ videoId: "seekSong001", title: "Seek", channel: "t", duration: "3:20", thumb: "" });
    const state = await host.waitState((s) => !!s.nowPlaying, "a song on stage");
    const itemId = state.nowPlaying!.id;
    const times: number[] = [];
    host.socket.on("playback:progress", (p) => times.push(Math.round(p.time)));

    tv.emit("screen:progress", { itemId, time: 10, duration: 200 });
    await until(() => times.includes(10), "the first report");
    host.emit("playback:seek", { seconds: 100 });
    await until(() => times.includes(100), "the optimistic position");
    tv.emit("screen:progress", { itemId, time: 11, duration: 200 }); // sent before the player jumped
    tv.emit("screen:progress", { itemId, time: 101, duration: 200 }); // after it jumped
    await until(() => times.includes(101), "the report after the jump");
    assert.ok(!times.includes(11), `the stale position must not reach phones (saw ${times.join(", ")})`);
  });
});

describe("payload fields", () => {
  it("rejects wrong field types before any handler runs, and still accepts valid ones", async () => {
    const { code, hostToken } = await createRoom(server.url);
    const host = newClient("fields-host");
    await host.join(code, hostToken);
    const bad = await host.socket.emitWithAck("queue:add", { video: { videoId: 12345678901, title: "x" } } as never);
    assert.equal(bad.ok, false);
    const badJoin = await newClient("fields-bad").socket.emitWithAck("room:join", { code, singerId: {}, name: "X" } as never);
    assert.equal(badJoin.ok, false);
    const nan = await host.socket.emitWithAck("queue:add", { video: { videoId: "fieldsSong1", title: 5 } } as never);
    assert.equal(nan.ok, false, "a non-string title is refused, not coerced");
    const good = await host.add({ videoId: "fieldsSong2", title: "Fine", channel: "c", duration: "3:00", thumb: "" });
    assert.equal(good.ok, true);
  });
});
