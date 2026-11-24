import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startServer, type TestServer } from "./harness.ts";

let server: TestServer;
before(async () => void (server = await startServer({ KARAOKE_TRUST_PROXY: "1" })));
after(async () => void (await server.stop()));

const json = { "content-type": "application/json" };
const login = (headers: Record<string, string> = {}) =>
  fetch(`${server.url}/api/admin/login`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ username: "Administrator", password: "password" }) });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

describe("admin session cookie", () => {
  it("is Secure only when the request came over HTTPS", async () => {
    assert.doesNotMatch((await login()).headers.get("set-cookie")!, /Secure/);
    const https = await login({ "x-forwarded-proto": "https" });
    assert.match(https.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure/);
  });

  it("gets a new token when the password changes, and the old one stops working", async () => {
    const old = cookieOf(await login());
    const res = await fetch(`${server.url}/api/admin/password`, { method: "POST", headers: { ...json, cookie: old }, body: JSON.stringify({ current: "password", next: "a-better-one" }) });
    assert.equal(res.status, 200);
    const fresh = cookieOf(res);
    assert.ok(fresh && fresh !== old);
    const session = async (cookie: string) => ((await (await fetch(`${server.url}/api/admin/session`, { headers: { cookie } })).json()) as { authenticated: boolean }).authenticated;
    assert.equal(await session(old), false);
    assert.equal(await session(fresh), true);
  });
});
