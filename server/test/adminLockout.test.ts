import { readFileSync } from "node:fs";
import path from "node:path";
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
    assert.equal(res.status, 429);
    assert.match(((await res.json()) as { error: string }).error, /blocked/);
    await wait(300);
    assert.equal((await login("password")).status, 429, "a permanent ban does not expire");
  });
});
