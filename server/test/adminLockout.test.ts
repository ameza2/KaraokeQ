import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startServer, wait, type TestServer } from "./harness.ts";

let server: TestServer;
before(async () => {
  server = await startServer({ KARAOKE_BLOCK_TEMP_MS: "250" });
});
after(async () => {
  await server.stop();
});

const login = (password: string) =>
  fetch(`${server.url}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Administrator", password }),
  });

describe("admin sign-in lockout", () => {
  it("answers 401 for four wrong passwords, then locks the device out, even for the right one", async () => {
    for (let i = 0; i < 4; i++) assert.equal((await login("wrong")).status, 401);
    const fifth = await login("wrong");
    assert.equal(fifth.status, 429);
    assert.match(((await fifth.json()) as { error: string }).error, /Try again in 1 minute/);
    assert.equal((await login("password")).status, 429, "the right password is refused while banned");
  });

  it("lets the device back in when the temporary ban ends, and blocks it for good after ten misses in a row", async () => {
    await wait(300);
    assert.equal((await login("password")).status, 200, "a correct sign-in after the ban works and clears the count");
    for (let i = 0; i < 10; i++) {
      await login("wrong");
      await wait(300);
    }
    const res = await login("password");
    assert.equal(res.status, 403, "a device blocked for good gets nothing from the server");
    assert.match(((await res.json()) as { error: string }).error, /blocked/);
    await wait(300);
    assert.equal((await login("password")).status, 403, "a permanent ban does not expire");
    assert.equal((await fetch(`${server.url}/api/info`)).status, 403, "not even the public API");
  });
});

describe("admin blocklist controls", () => {
  let cookie = "";
  let other: TestServer;
  const call = (method: string, p: string, body?: unknown) =>
    fetch(`${other.url}/api/admin${p}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

  before(async () => {
    other = await startServer({ KARAOKE_BLOCK_TEMP_MS: "60000" });
    const res = await fetch(`${other.url}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "Administrator", password: "password" }) });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    await fetch(`${other.url}/api/admin/password`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ current: "password", next: "a-better-one" }) });
  });
  after(async () => {
    await other.stop();
  });

  it("needs a session", async () => {
    const res = await fetch(`${other.url}/api/admin/blocklist`);
    assert.equal(res.status, 401);
  });

  it("blocks and unblocks a device by address, and refuses to block the admin's own", async () => {
    const empty = (await (await call("GET", "/blocklist"))!.json()) as { yourAddress: string; permanent: unknown[]; temporary: unknown[] };
    assert.deepEqual([empty.permanent, empty.temporary], [[], []]);

    assert.equal((await call("POST", "/blocklist", { address: "not an address" }))!.status, 400);
    assert.equal((await call("POST", "/blocklist", { address: empty.yourAddress }))!.status, 400);

    const added = await call("POST", "/blocklist", { address: "192.168.1.77" });
    assert.equal(added!.status, 200);
    assert.equal(((await added!.json()) as { permanent: { address: string }[] }).permanent[0]!.address, "192.168.1.77");
    assert.equal((await call("POST", "/blocklist", { address: "192.168.1.77" }))!.status, 409);

    assert.equal((await call("DELETE", "/blocklist/192.168.1.77"))!.status, 200);
    assert.equal((await call("DELETE", "/blocklist/192.168.1.77"))!.status, 404);
  });

  it("lists a temporary ban and lets the admin end it early", async () => {
    // five wrong sign-ins from this address (the admin's own session keeps working)
    for (let i = 0; i < 5; i++) await fetch(`${other.url}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "x", password: "y" }) });
    const report = (await (await call("GET", "/blocklist"))!.json()) as { yourAddress: string; temporary: { address: string; scope: string; retryAfterMs: number }[] };
    assert.equal(report.temporary.length, 1);
    assert.equal(report.temporary[0]!.scope, "login");
    assert.ok(report.temporary[0]!.retryAfterMs > 0);

    assert.equal((await call("DELETE", `/blocklist/${encodeURIComponent(report.yourAddress)}`))!.status, 200);
    const after = (await (await call("GET", "/blocklist"))!.json()) as { temporary: unknown[] };
    assert.equal(after.temporary.length, 0);
  });
});
