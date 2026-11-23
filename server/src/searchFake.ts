import type { Express } from "express";
import { searchCacheSize, setSearchBackend, type RawVideo, type SearchBackend, type SearchFeed } from "./search.ts";

/**
 * A pretend YouTube for tests and `npm run stress`: no network, deterministic results, and it
 * counts every call it receives. Turned on in the server with KARAOKE_FAKE_YOUTUBE=1.
 */
export interface FakeOptions {
  pageSize?: number; // videos per YouTube page (default 20)
  maxPages?: number; // YouTube pages per search (default: endless)
  embedDelayMs?: number; // pretend oEmbed latency
  searchDelayMs?: number; // pretend search latency
  /** Which videos refuse embedding (default: every 7th, starting at the 4th). */
  blocked?: (index: number) => boolean;
}

export interface FakeStats {
  searches: number;
  continuations: number;
  embedChecks: number;
  suggests: number;
}

const wait = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** "Some Song karaoke" -> "some-song" (the " karaoke" the server adds is not part of the id). */
const slug = (q: string) => q.toLowerCase().replace(/\s*karaoke\s*$/, "").trim().replace(/[^a-z0-9]+/g, "-");

export function createFakeBackend(opts: FakeOptions = {}): SearchBackend & { stats: FakeStats } {
  const perPage = opts.pageSize ?? 20;
  const blocked = opts.blocked ?? ((i: number) => i % 7 === 3);
  const stats: FakeStats = { searches: 0, continuations: 0, embedChecks: 0, suggests: 0 };

  const page = (query: string, n: number): SearchFeed => {
    const s = slug(query);
    const videos: RawVideo[] = Array.from({ length: perPage }, (_, k) => {
      const i = n * perPage + k;
      return { videoId: `${s}~${i}`, title: `${s} #${i}`, channel: "Fake Karaoke", duration: "3:30" };
    });
    const more = opts.maxPages === undefined || n + 1 < opts.maxPages;
    return {
      videos,
      next: more
        ? async () => {
            stats.continuations++;
            await wait(opts.searchDelayMs ?? 0);
            return page(query, n + 1);
          }
        : null,
    };
  };

  return {
    stats,
    async search(query) {
      stats.searches++;
      await wait(opts.searchDelayMs ?? 0);
      return page(query, 0);
    },
    async checkEmbeddable(videoId) {
      stats.embedChecks++;
      await wait(opts.embedDelayMs ?? 0);
      const i = Number(videoId.slice(videoId.lastIndexOf("~") + 1));
      return !blocked(i);
    },
    async suggest(query) {
      stats.suggests++;
      return [`${query} lyrics`, `${query} live`, `${query} acoustic`];
    },
  };
}

/** The server's switch: install the fake and expose what it was asked (and the server's memory), at /api/_fake-youtube. */
export function installFakeYoutube(app: Express) {
  const fake = createFakeBackend({ embedDelayMs: Number(process.env.KARAOKE_FAKE_EMBED_MS) || 0, searchDelayMs: Number(process.env.KARAOKE_FAKE_SEARCH_MS) || 0 });
  setSearchBackend(fake);
  app.get("/api/_fake-youtube", (_req, res) => {
    const mem = process.memoryUsage();
    res.json({ ...fake.stats, cachedSearches: searchCacheSize(), rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) });
  });
  console.warn("KARAOKE_FAKE_YOUTUBE is on: search results are made up.");
}
