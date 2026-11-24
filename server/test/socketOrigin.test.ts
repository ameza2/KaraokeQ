import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { sameOrigin } from "../src/net.ts";
import { startServer, type TestServer } from "./harness.ts";

let server: TestServer;
before(async () => void (server = await startServer()));
after(async () => void (await server.stop()));

const connect = (origin?: string) =>
  new Promise<boolean>((resolve) => {
    const s = io(server.url, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: origin ? { origin } : {} });
    s.on("connect", () => (s.close(), resolve(true)));
    s.on("connect_error", () => (s.close(), resolve(false)));
  });

describe("socket origin check", () => {
  it("matches the origin's host and port to the host asked for", () => {
    assert.equal(sameOrigin(undefined, "a.nip.io"), true);
    assert.equal(sameOrigin("http://a.nip.io:3001", "a.nip.io:3001"), true);
    assert.equal(sameOrigin("https://A.nip.io", "a.nip.io"), true);
    assert.equal(sameOrigin("https://evil.example", "a.nip.io"), false);
    assert.equal(sameOrigin("http://a.nip.io:5173", "a.nip.io:3001"), false);
    assert.equal(sameOrigin("null", "a.nip.io"), false);
    assert.equal(sameOrigin("http://a.nip.io", undefined), false);
  });

  it("accepts the server's own page and clients with no origin, and refuses another site", async () => {
    assert.equal(await connect(), true);
    assert.equal(await connect(server.url), true);
    assert.equal(await connect("https://evil.example"), false);
  });
});
