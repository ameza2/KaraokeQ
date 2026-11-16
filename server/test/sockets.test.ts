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
