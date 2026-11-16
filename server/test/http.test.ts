import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CreateRoomResponse, RoomExistsResponse, ServerInfo } from "@karaoke/shared";
import { Client, createRoom, startServer, video, type TestServer } from "./harness.ts";

let server: TestServer;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.stop();
});

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");

describe("HTTP headers", () => {
  it("sets baseline security headers and hides the framework", async () => {
    const res = await fetch(`${server.url}/api/info`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  it("never caches admin responses", async () => {
    const res = await fetch(`${server.url}/api/admin/session`);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("returns JSON for unknown API paths", async () => {
    const res = await fetch(`${server.url}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found." });
  });

  it("caches hashed assets for good and always re-checks index.html", { skip: !existsSync(path.join(dist, "index.html")) }, async () => {
    const page = await fetch(`${server.url}/`);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    const html = await page.text();
    const asset = /\/assets\/[\w.-]+\.js/.exec(html)?.[0];
    assert.ok(asset, "index.html links a hashed script");
    const js = await fetch(`${server.url}${asset}`);
    assert.match(js.headers.get("cache-control") ?? "", /immutable/);
    const deep = await fetch(`${server.url}/r/ABCD`); // SPA fallback
    assert.equal(deep.headers.get("cache-control"), "no-cache");
  });

  it("gzips the client bundle when the browser accepts it, and leaves tiny responses alone", { skip: !existsSync(path.join(dist, "index.html")) }, async () => {
    const html = await (await fetch(`${server.url}/`)).text();
    const asset = /\/assets\/[\w.-]+\.js/.exec(html)?.[0];
    assert.ok(asset);
    const gz = await fetch(`${server.url}${asset}`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(gz.headers.get("content-encoding"), "gzip");
    assert.match(gz.headers.get("vary") ?? "", /accept-encoding/i);
    const plain = await fetch(`${server.url}${asset}`, { headers: { "accept-encoding": "identity" } });
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal((await gz.text()).length, (await plain.text()).length, "same content either way");
    const tiny = await fetch(`${server.url}/api/rooms/NOPE`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(tiny.headers.get("content-encoding"), null);
  });

  it("rejects an oversized JSON body", async () => {
    const res = await fetch(`${server.url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: "x".repeat(30_000) }) });
    assert.equal(res.status, 413);
  });
});

describe("Content-Security-Policy (report-only)", () => {
  it("is sent in report-only mode and names the YouTube origins and this host", async () => {
    const res = await fetch(`${server.url}/api/info`);
    assert.equal(res.headers.get("content-security-policy"), null, "not enforcing yet");
    const csp = res.headers.get("content-security-policy-report-only") ?? "";
    const host = new URL(server.url).host;
    for (const part of [
      "script-src 'self' https://www.youtube.com",
      "frame-src https://www.youtube.com",
      "img-src 'self' data: https://i.ytimg.com",
      `ws://${host}`, // older Safari does not count ws:// as 'self'
      "*.nip.io:*", // a host without a port only matches the default port
      "*.sslip.io:*",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "report-uri /api/csp-report",
    ])
      assert.ok(csp.includes(part), `policy should contain: ${part}\n${csp}`);
  });

  it("accepts reports quietly, whatever their shape", async () => {
    const post = (body: string, type = "application/csp-report") => fetch(`${server.url}/api/csp-report`, { method: "POST", headers: { "content-type": type }, body });
    const classic = await post(JSON.stringify({ "csp-report": { "violated-directive": "img-src", "blocked-uri": "https://x.example/a.png", "document-uri": "http://localhost/r/ABCD?q=1" } }));
    assert.equal(classic.status, 204);
    const modern = await post(JSON.stringify([{ type: "csp-violation", body: { effectiveDirective: "script-src", blockedURL: "https://y.example/b.js" } }]), "application/reports+json");
    assert.equal(modern.status, 204);
    const empty = await post("{}");
    assert.equal(empty.status, 204);
    const huge = await post(JSON.stringify({ pad: "x".repeat(20_000) }));
    assert.ok([204, 413].includes(huge.status));
    // the server is still fine afterwards
    assert.equal((await fetch(`${server.url}/api/info`)).status, 200);
  });
});

describe("socket limits", () => {
  it("answers a flood with 'slow down' instead of working through it", async () => {
    const { code } = await createRoom(server.url);
    const c = new Client(server.url, "flooder");
    await c.join(code);
    const replies = await Promise.all(Array.from({ length: 300 }, () => c.add(video())));
    const limited = replies.filter((r) => !r.ok && /slow down/i.test(r.error));
    assert.ok(limited.length > 100, `expected many limited replies, got ${limited.length}`);
    c.close();
  });

  it("does not limit normal use", async () => {
    const { code } = await createRoom(server.url);
    const c = new Client(server.url, "normal");
    await c.join(code);
    for (let i = 0; i < 5; i++) assert.ok((await c.add(video())).ok);
    c.close();
  });
});

describe("API errors answer with JSON", () => {
  const post = (body: string) => fetch(`${server.url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body });

  it("a malformed JSON body is a 400, not an HTML error page", async () => {
    const res = await post("{not json");
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { error: "That request was not understood." });
  });

  it("a body over the limit is a 413 and leaks no stack trace", async () => {
    const res = await post(JSON.stringify({ pad: "x".repeat(30_000) }));
    assert.equal(res.status, 413);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "That request is too large." });
  });
});

describe("public API response shapes", () => {
  const post = (body: object) => fetch(`${server.url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("POST /api/rooms gives a host token to a client and none to a screen", async () => {
    const asClient = (await (await post({ by: "client" })).json()) as CreateRoomResponse;
    assert.match(asClient.code, /^[A-Z0-9]{4,8}$/);
    assert.equal(typeof asClient.hostToken, "string");
    const asScreen = (await (await post({ by: "screen" })).json()) as CreateRoomResponse;
    assert.equal(asScreen.hostToken, undefined);
  });

  it("GET /api/rooms/:code says whether the room exists", async () => {
    const { code } = (await (await post({ by: "client" })).json()) as CreateRoomResponse;
    assert.deepEqual((await (await fetch(`${server.url}/api/rooms/${code}`)).json()) as RoomExistsResponse, { exists: true });
    assert.deepEqual((await (await fetch(`${server.url}/api/rooms/NOPE0`)).json()) as RoomExistsResponse, { exists: false });
  });

  it("GET /api/info lists the LAN addresses and the shareable host", async () => {
    const info = (await (await fetch(`${server.url}/api/info`)).json()) as ServerInfo;
    assert.ok(Array.isArray(info.lanIps) && info.lanIps.every((ip) => typeof ip === "string"));
    assert.ok(info.shareHost === null || typeof info.shareHost === "string");
  });
});
