import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { socketAddress, trustedProxies } from "../src/net.ts";
import { startServer, type TestServer } from "./harness.ts";

const sock = (address: string, xff?: string) => ({ handshake: { address, headers: xff === undefined ? {} : { "x-forwarded-for": xff } } });

describe("trusted proxies", () => {
  it("reads the env var as a hop count, and anything else as none", () => {
    assert.equal(trustedProxies("1"), 1);
    assert.equal(trustedProxies(" 2 "), 2);
    for (const bad of [undefined, "", "0", "true", "-1", "1.5", "99", "abc"]) assert.equal(trustedProxies(bad), 0, String(bad));
  });

  it("ignores X-Forwarded-For when no proxy is trusted", () => {
    assert.equal(socketAddress(sock("10.0.0.5", "6.6.6.6"), 0), "10.0.0.5");
  });

  it("takes the address the nearest trusted proxy saw, so a faked leading entry changes nothing", () => {
    assert.equal(socketAddress(sock("172.18.0.2", "6.6.6.6, 203.0.113.9"), 1), "203.0.113.9");
    assert.equal(socketAddress(sock("172.18.0.2", "203.0.113.9"), 1), "203.0.113.9");
    assert.equal(socketAddress(sock("172.18.0.3", "6.6.6.6, 203.0.113.9, 172.18.0.2"), 2), "203.0.113.9");
  });

  it("falls back to the connection's address when the header is missing", () => {
    assert.equal(socketAddress(sock("10.0.0.5"), 1), "10.0.0.5");
  });
});

describe("per-address limits over HTTP", () => {
  let server: TestServer | undefined;
  after(async () => void (await server?.stop()));

  const wrongLogins = async (url: string, xff: (i: number) => string, count: number) => {
    let last = 0;
    for (let i = 0; i < count; i++) {
      const res = await fetch(`${url}/api/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": xff(i) },
        body: JSON.stringify({ username: "x", password: "y" }),
      });
      last = res.status;
    }
    return last;
  };

  it("cannot be dodged with a made-up X-Forwarded-For when no proxy is trusted", async () => {
    server = await startServer();
    assert.equal(await wrongLogins(server.url, (i) => `9.9.9.${i}`, 5), 429);
    await server.stop();
    server = undefined;
  });

  it("counts each forwarded address on its own when one proxy is trusted", async () => {
    server = await startServer({ KARAOKE_TRUST_PROXY: "1" });
    assert.equal(await wrongLogins(server.url, (i) => `9.9.9.${i}`, 5), 401, "five different visitors, none locked out");
    assert.equal(await wrongLogins(server.url, () => "9.9.9.200", 5), 429, "one visitor guessing five times is");
  });
});
