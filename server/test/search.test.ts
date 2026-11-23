import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { markNotEmbeddable, searchCacheSize, searchVideos, setSearchBackend, sweepSearchCache } from "../src/search.ts";
import { createFakeBackend, type FakeOptions } from "../src/searchFake.ts";

const HOUR = 3600e3;
let now = 0;
let fake: ReturnType<typeof createFakeBackend>;

function useFake(opts: FakeOptions = {}) {
  fake = createFakeBackend(opts);
  now = 1_000_000;
  setSearchBackend(fake, () => now);
}

const ids = (r: { results: { videoId: string }[] }) => r.results.map((v) => v.videoId);
const num = (id: string) => Number(id.slice(id.lastIndexOf("~") + 1));
const none = () => false; // nothing is blocked

beforeEach(() => useFake({ blocked: none }));

describe("paged search", () => {
  it("gives one slice per page, in order, without overlap", async () => {
    const a = await searchVideos("tom", 0, 10, false);
    const b = await searchVideos("tom", 1, 10, false);
    const c = await searchVideos("tom", 2, 10, false);
    assert.deepEqual([...ids(a), ...ids(b), ...ids(c)].map(num), Array.from({ length: 30 }, (_, i) => i));
    assert.equal(a.page, 0);
    assert.equal(c.page, 2);
    assert.ok(c.hasMore);
  });

  it("a different page size is just a different slice of the same list", async () => {
    const big = await searchVideos("tom", 1, 25, false); // results 25..49
    const small = await searchVideos("tom", 5, 5, false); // results 25..29
    assert.deepEqual(ids(small), ids(big).slice(0, 5));
    assert.equal(num(ids(big)[0]!), 25);
  });

  it("serves a page that was already fetched without asking YouTube again", async () => {
    await searchVideos("tom", 2, 10, false);
    const before = { ...fake.stats };
    await searchVideos("tom", 1, 10, false);
    await searchVideos("tom", 0, 25, false);
    assert.deepEqual(fake.stats, before);
  });

  it("a page past the end gives the last page that exists", async () => {
    useFake({ blocked: none, maxPages: 2 }); // 40 videos in all
    const r = await searchVideos("short", 9, 10, false);
    assert.equal(r.page, 3);
    assert.equal(r.total, 40);
    assert.equal(r.hasMore, false);
    assert.equal(r.results.length, 10);
  });

  it("stops at 500 videos however long YouTube goes on", async () => {
    const r = await searchVideos("endless", 40, 100, false);
    assert.ok(r.total >= 500 && r.total <= 520, `total ${r.total}`);
    assert.equal(r.hasMore, false);
    assert.ok(r.page <= 5);
  });

  it("answers an empty search with an empty page and does not call YouTube", async () => {
    const r = await searchVideos("   ", 0, 25, false);
    assert.deepEqual(r.results, []);
    assert.equal(fake.stats.searches, 0);
  });
});

describe("playable only", () => {
  it("fills every page with videos that can play and counts the hidden ones", async () => {
    useFake({}); // every 7th video refuses embedding
    const r = await searchVideos("filtered", 1, 10, true);
    assert.equal(r.results.length, 10);
    assert.ok(r.results.every((v) => v.embeddable !== false));
    assert.ok(r.hidden > 0);
    const all = await searchVideos("filtered", 0, 25, false); // casting: nothing is filtered
    assert.ok(ids(all).some((id) => num(id) % 7 === 3), "blocked videos are listed when not filtering");
    assert.ok(all.results.some((v) => v.embeddable === false));
  });

  it("keeps positions steady when a video turns out not to play later", async () => {
    const first = await searchVideos("steady", 0, 10, true);
    const second = await searchVideos("steady", 1, 10, true);
    const victim = ids(first)[4]!;
    markNotEmbeddable(victim); // a screen reported error 150 for it
    const again = await searchVideos("steady", 0, 10, true);
    const second2 = await searchVideos("steady", 1, 10, true);
    assert.deepEqual(ids(again), ids(first), "page 1 did not shift");
    assert.deepEqual(ids(second2), ids(second), "page 2 did not shift");
    assert.equal(again.results[4]!.embeddable, false, "the video is marked, not removed");
  });
});

describe("cache life", () => {
  it("keeps the same version while a search is in use, even past the expiry time", async () => {
    const a = await searchVideos("long session", 0, 10, false);
    now += 5 * HOUR;
    const b = await searchVideos("long session", 1, 10, false);
    now += 5 * HOUR; // 10 hours after the start, 5 after the last use
    const c = await searchVideos("long session", 2, 10, false);
    assert.equal(b.version, a.version);
    assert.equal(c.version, a.version);
  });

  it("starts a new version after the search was idle for the whole expiry time", async () => {
    const a = await searchVideos("idle", 0, 10, false);
    now += 6 * HOUR + 1000;
    const b = await searchVideos("idle", 0, 10, false);
    assert.notEqual(b.version, a.version);
    assert.equal(fake.stats.searches, 2);
  });

  it("the cleanup removes idle searches and keeps recent ones", async () => {
    await searchVideos("old one", 0, 10, false);
    now += 5 * HOUR;
    await searchVideos("fresh one", 0, 10, false);
    now += 2 * HOUR; // "old one" has been idle 7 hours, "fresh one" 2
    sweepSearchCache();
    assert.equal(searchCacheSize(), 1);
    const before = fake.stats.searches;
    await searchVideos("fresh one", 0, 10, false);
    assert.equal(fake.stats.searches, before, "the recent search was kept");
  });

  it("different capitalisation and spacing share one entry", async () => {
    const a = await searchVideos("Queen  Bohemian Rhapsody", 0, 10, false);
    const b = await searchVideos("queen bohemian rhapsody ", 0, 10, false);
    assert.equal(a.version, b.version);
    assert.equal(fake.stats.searches, 1);
  });
});

describe("failures", () => {
  it("does not cache a search that failed, so the next try starts fresh", async () => {
    let fail = true;
    const real = createFakeBackend({ blocked: none });
    setSearchBackend({
      ...real,
      search: async (q) => {
        if (fail) throw new Error("YouTube is down");
        return real.search(q);
      },
    }, () => now);
    await assert.rejects(searchVideos("flaky", 0, 10, false), /YouTube is down/);
    assert.equal(searchCacheSize(), 0);
    fail = false;
    assert.equal((await searchVideos("flaky", 0, 10, false)).results.length, 10);
  });

  it("a failing later page ends the list instead of failing the search", async () => {
    const real = createFakeBackend({ blocked: none });
    setSearchBackend({
      ...real,
      search: async (q) => {
        const feed = await real.search(q);
        return { ...feed, next: async () => { throw new Error("continuation broke"); } };
      },
    }, () => now);
    const r = await searchVideos("brittle", 3, 10, false);
    assert.equal(r.total, 20);
    assert.equal(r.page, 1);
    assert.equal(r.hasMore, false);
  });
});
