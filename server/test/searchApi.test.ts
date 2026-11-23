import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SearchPage } from "@karaoke/shared";
import { startServer, type TestServer } from "./harness.ts";

let server: TestServer;
before(async () => {
  server = await startServer({ KARAOKE_FAKE_YOUTUBE: "1" });
});
after(async () => {
  await server.stop();
});

const get = async (qs: string) => (await (await fetch(`${server.url}/api/search?${qs}`)).json()) as SearchPage;

describe("GET /api/search", () => {
  it("returns the page and page size asked for", async () => {
    const p0 = await get("q=abba&page=0&pageSize=10");
    const p1 = await get("q=abba&page=1&pageSize=10");
    assert.equal(p0.results.length, 10);
    assert.equal(p1.page, 1);
    assert.notEqual(p0.results[0]!.videoId, p1.results[0]!.videoId);
    assert.equal(p0.version, p1.version);
    assert.ok(p0.total >= 10);
  });

  it("copes with a nonsense page or page size", async () => {
    const r = await get("q=abba&page=-4&pageSize=100000");
    assert.equal(r.page, 0);
    assert.equal(r.pageSize, 100);
    const s = await get("q=abba&page=x&pageSize=y");
    assert.equal(s.page, 0);
    assert.equal(s.pageSize, 25);
  });

  it("counts every call it makes to YouTube", async () => {
    const stats = (await (await fetch(`${server.url}/api/_fake-youtube`)).json()) as { searches: number };
    assert.ok(stats.searches >= 1);
  });
});

describe("GET /api/search when YouTube is rationed", () => {
  it("answers 503 with a plain message instead of calling YouTube again", async () => {
    const tight = await startServer({ KARAOKE_FAKE_YOUTUBE: "1", KARAOKE_YT_BUDGET_PER_MIN: "1" });
    try {
      const ok = await fetch(`${tight.url}/api/search?q=one&page=0&pageSize=10`);
      assert.equal(ok.status, 200);
      const busy = await fetch(`${tight.url}/api/search?q=two&page=0&pageSize=10`);
      assert.equal(busy.status, 503);
      assert.deepEqual(await busy.json(), { error: "Search is busy, try again in a moment." });
      const cached = await fetch(`${tight.url}/api/search?q=one&page=0&pageSize=10`);
      assert.equal(cached.status, 200, "a search already cached still works");
    } finally {
      await tight.stop();
    }
  });
});
