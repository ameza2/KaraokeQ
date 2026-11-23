import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SearchBusyError, markNotEmbeddable, searchCacheSize, searchIdle, searchLimits, searchVideos, setSearchBackend, suggest, sweepSearchCache } from "../src/search.ts";
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
    assert.equal(c.complete, false, "YouTube has more, so the total can still grow");
  });

  it("a different page size is just a different slice of the same list", async () => {
    const big = await searchVideos("tom", 1, 25, false); // results 25..49
    const small = await searchVideos("tom", 5, 5, false); // results 25..29
    assert.deepEqual(ids(small), ids(big).slice(0, 5));
    assert.equal(num(ids(big)[0]!), 25);
  });

  it("serves a page that was already fetched without asking YouTube again", async () => {
    await searchVideos("tom", 2, 10, false);
    await searchIdle(); // let the look-ahead finish
    const before = { ...fake.stats };
    await searchVideos("tom", 1, 10, false);
    await searchVideos("tom", 0, 10, false);
    await searchIdle();
    assert.deepEqual(fake.stats, before);
  });

  it("a page past the end gives the last page that exists", async () => {
    useFake({ blocked: none, maxPages: 2 }); // 40 videos in all
    const r = await searchVideos("short", 9, 10, false);
    assert.equal(r.page, 3);
    assert.equal(r.total, 40);
    assert.equal(r.hasMore, false);
    assert.equal(r.complete, true);
    assert.equal(r.results.length, 10);
    const earlier = await searchVideos("short", 0, 10, false);
    assert.equal(earlier.hasMore, true, "pages follow");
    assert.equal(earlier.complete, true, "but the list is complete, so the total is exact");
  });

  it("stops at 250 videos however long YouTube goes on", async () => {
    let r = await searchVideos("endless", 0, 100, false);
    for (let i = 0; i < 20 && r.hasMore; i++) r = await searchVideos("endless", r.page + 3, 100, false); // keep jumping on
    assert.ok(r.total >= 250 && r.total <= 270, `total ${r.total}`);
    assert.equal(r.hasMore, false);
    assert.ok(r.page <= 2);
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
    now += 6000; // YouTube is left alone for a few seconds after a failure
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

describe("protecting YouTube", () => {
  it("serves cached pages but says busy once the shared budget is used up", async () => {
    searchLimits.budgetPerMin = 3;
    await searchVideos("rationed", 0, 10, false); // 1 fetch
    const r = await searchVideos("rationed", 9, 10, false); // wants 10 pages: gets 2 more, then the budget is gone
    assert.equal(r.busy, true);
    assert.equal(r.total, 60);
    assert.equal(r.page, 5, "lands on the furthest page that is ready");
    assert.equal(r.hasMore, true);
    const again = await searchVideos("rationed", 0, 10, false);
    assert.equal(again.results.length, 10, "pages already loaded keep working");
    assert.equal(again.busy, undefined);
  });

  it("a search with nothing cached is refused when the budget is gone", async () => {
    searchLimits.budgetPerMin = 1;
    await searchVideos("first", 0, 10, false);
    await assert.rejects(searchVideos("second", 0, 10, false), SearchBusyError);
    assert.equal(searchCacheSize(), 1, "the refused search was not cached");
  });

  it("the budget comes back a minute later", async () => {
    searchLimits.budgetPerMin = 1;
    await searchVideos("minute", 0, 10, false);
    await assert.rejects(searchVideos("other", 0, 10, false), SearchBusyError);
    now += 61e3;
    assert.equal((await searchVideos("other", 0, 10, false)).results.length, 10);
  });

  it("one phone can use only its share of the budget, and others still get theirs", async () => {
    searchLimits.budgetPerMin = 8;
    searchLimits.perPhoneShare = 0.25; // 2 fetches a minute each
    const hog = await searchVideos("hog", 9, 10, false, "phone-1"); // wants 10 pages
    assert.equal(hog.busy, true);
    assert.equal(fake.stats.searches + fake.stats.continuations, 2, "the hog stopped at its share");
    await assert.rejects(searchVideos("hog two", 0, 10, false, "phone-1"), SearchBusyError, "a new search from the hog is refused");
    const other = await searchVideos("other", 0, 10, false, "phone-2");
    assert.equal(other.results.length, 10, "another phone is not affected");
    assert.equal((await searchVideos("hog", 0, 10, false, "phone-1")).results.length, 10, "the hog still sees pages already loaded");
  });

  it("the share is counted over a minute and a cached search costs nothing", async () => {
    searchLimits.budgetPerMin = 8;
    searchLimits.perPhoneShare = 0.25;
    await searchVideos("song", 0, 10, false, "a");
    await searchVideos("song", 0, 10, false, "b"); // cached: free for b
    assert.equal(fake.stats.searches, 1);
    await searchVideos("song", 9, 10, false, "a"); // a uses its second fetch, then runs out
    await assert.rejects(searchVideos("fresh", 0, 10, false, "a"), SearchBusyError);
    now += 61e3;
    assert.equal((await searchVideos("fresh", 0, 10, false, "a")).results.length, 10);
  });

  it("one request fetches at most a few YouTube pages, however far it jumps", async () => {
    const r = await searchVideos("far", 30, 100, false);
    assert.equal(fake.stats.searches + fake.stats.continuations, searchLimits.maxFetchesPerRequest);
    assert.ok(r.total <= searchLimits.maxFetchesPerRequest * 20);
    assert.equal(r.hasMore, true);
  });

  it("leaves YouTube alone for a few seconds after it fails", async () => {
    const real = createFakeBackend({ blocked: none });
    let calls = 0;
    setSearchBackend({ ...real, search: async () => { calls++; throw new Error("down"); } }, () => now);
    await assert.rejects(searchVideos("a", 0, 10, false), /down/);
    await assert.rejects(searchVideos("b", 0, 10, false), SearchBusyError);
    assert.equal(calls, 1, "the second search did not reach YouTube");
  });

  it("checks embedding a few videos at a time, never all at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const real = createFakeBackend({});
    setSearchBackend({
      ...real,
      checkEmbeddable: async (id) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return real.checkEmbeddable(id);
      },
    }, () => now);
    await searchVideos("polite", 2, 10, true);
    assert.ok(peak > 1 && peak <= searchLimits.embedConcurrency, `peak ${peak}`);
  });

  it("checks only as many videos as the page needs", async () => {
    await searchVideos("lazy", 0, 10, true);
    assert.ok(fake.stats.embedChecks <= 15, `checked ${fake.stats.embedChecks}`); // 10 wanted, checked 5 at a time
  });

  it("does not check embedding at all when the room is casting", async () => {
    await searchVideos("cast", 1, 25, false);
    assert.equal(fake.stats.embedChecks, 0);
  });

  it("looks one page ahead after answering, so Next is quick", async () => {
    await searchVideos("ahead", 0, 20, false); // the first YouTube page covers it
    await searchIdle();
    assert.equal(fake.stats.continuations, 1, "page 2 was fetched in the background");
    const next = await searchVideos("ahead", 1, 20, false);
    assert.equal(next.results.length, 20);
    assert.equal(next.total, 40, "page 2 was already there when asked for");
    await searchIdle();
    assert.equal(fake.stats.continuations, 2, "and the look-ahead moved on to page 3");
  });

  it("does not look ahead while most of the budget is already used", async () => {
    searchLimits.budgetPerMin = 4;
    await searchVideos("a1", 0, 10, false);
    await searchVideos("a2", 0, 10, false);
    await searchVideos("a3", 0, 10, false); // 3 of 4 used
    await searchIdle();
    const before = fake.stats.continuations + fake.stats.searches;
    await searchVideos("a1", 1, 10, false); // would need a new page; the look-ahead beyond is skipped
    await searchIdle();
    assert.ok(fake.stats.continuations + fake.stats.searches - before <= 1);
  });
});

describe("autocomplete", () => {
  it("remembers an answer for five minutes, whatever the capitalisation", async () => {
    await suggest("tay");
    await suggest("TAY ");
    assert.equal(fake.stats.suggests, 1);
    now += 5 * 60e3 + 1000;
    await suggest("tay");
    assert.equal(fake.stats.suggests, 2);
  });

  it("answers phones that type the same thing at the same time with one call", async () => {
    await Promise.all([suggest("bey"), suggest("bey"), suggest("bey")]);
    assert.equal(fake.stats.suggests, 1);
  });

  it("never remembers a failure", async () => {
    const real = createFakeBackend({});
    let fail = true;
    setSearchBackend({ ...real, suggest: async (q) => { if (fail) throw new Error("no"); return real.suggest(q); } }, () => now);
    await assert.rejects(suggest("oops"));
    fail = false;
    assert.equal((await suggest("oops")).length, 3);
  });
});
