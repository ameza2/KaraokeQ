import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { Client, createRoom, startServer, wait, type TestServer } from "./harness.ts";

const BAD = "ZZZZ"; // a code no room has

const get = (server: TestServer, p: string) => fetch(`${server.url}${p}`);
const exists = async (server: TestServer, code: string) => {
  const res = await get(server, `/api/rooms/${code}`);
  return { status: res.status, body: (await res.json()) as { exists?: boolean; error?: string } };
};

describe("room code guessing over HTTP", () => {
  let server: TestServer;
  before(async () => void (server = await startServer({ KARAOKE_BLOCK_TEMP_MS: "400" })));
  after(async () => void (await server.stop()));

  it("answers normally for four wrong codes, locks the device out on the fifth, and ends the timeout on its own", async () => {
    for (let i = 0; i < 4; i++) assert.deepEqual(await exists(server, BAD), { status: 200, body: { exists: false } });
    const fifth = await exists(server, BAD);
    assert.equal(fifth.status, 429);
    assert.match(fifth.body.error ?? "", /Try again/);

    const real = await createRoom(server.url);
    assert.equal((await exists(server, real.code)).status, 429, "a right code is refused too while the device is in a timeout");

    await wait(450);
    assert.deepEqual(await exists(server, real.code), { status: 200, body: { exists: true } });
  });

  it("does not let a right code wipe out the count, so interleaving one cannot dodge the lockout", async () => {
    await wait(450);
    const real = await createRoom(server.url);
    let locked = false;
    for (let i = 0; i < 6 && !locked; i++) {
      await exists(server, real.code); // the "good" guess between bad ones
      locked = (await exists(server, BAD)).status === 429;
    }
    assert.ok(locked, "the device was locked out within five wrong guesses");
  });
});

describe("room code guessing over sockets", () => {
  let server: TestServer;
  before(async () => void (server = await startServer({ KARAOKE_BLOCK_TEMP_MS: "400" })));
  after(async () => void (await server.stop()));

  it("counts wrong codes on room:join and screen:join together", async () => {
    const c = new Client(server.url, "guesser");
    for (let i = 0; i < 2; i++) assert.match(((await c.join(BAD)) as { error: string }).error, /doesn't exist/);
    for (let i = 0; i < 2; i++) assert.match(((await c.joinScreen(BAD)) as { error: string }).error, /doesn't exist/);
    const fifth = (await c.join(BAD)) as { ok: false; error: string };
    assert.match(fifth.error, /Try again in/);

    const real = await createRoom(server.url);
    assert.match(((await c.join(real.code)) as { error: string }).error, /Try again in/, "even a right code is refused during the timeout");
    c.socket.close();

    await wait(450);
    const d = new Client(server.url, "returning");
    assert.equal((await d.join(real.code)).ok, true);
    d.socket.close();
  });
});

describe("a device blocked for good", () => {
  let server: TestServer;
  before(async () => void (server = await startServer({ KARAOKE_BLOCK_TEMP_MS: "60" })));
  after(async () => void (await server.stop()));

  it("is blocked after ten wrong codes in a row, and then gets nothing: no pages, no sockets, not even a right code", async () => {
    const real = await createRoom(server.url);
    for (let i = 0; i < 10; i++) {
      await exists(server, BAD);
      await wait(80); // wait out each short timeout
    }
    for (const path of ["/api/info", `/api/rooms/${real.code}`, "/"]) assert.equal((await get(server, path)).status, 403, path);

    const socket = io(server.url, { transports: ["websocket"], forceNew: true, reconnection: false });
    const error = await new Promise<Error>((resolve) => socket.on("connect_error", resolve));
    assert.match(error.message, /blocked/);
    socket.close();
  });
});
