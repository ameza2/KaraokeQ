import { randomUUID } from "node:crypto";
import { Innertube, Log, YTNodes } from "youtubei.js";
import type { SearchPage, VideoResult } from "@karaoke/shared";

// The parser logs a warning for every node type YouTube has changed ("Type mismatch, got
// DecoratedAvatarView expected AvatarView", dozens per search). Searching still works, so keep
// only real errors out of the system log.
Log.setLevel(Log.Level.ERROR);

// ---------- the YouTube side (swappable, so tests and the stress test need no network) ----------

export interface RawVideo {
  videoId: string;
  title: string;
  channel: string;
  duration: string;
}

/** One page of YouTube results, and how to get the next one (null = there is no next page). */
export interface SearchFeed {
  videos: RawVideo[];
  next: (() => Promise<SearchFeed>) | null;
}

export interface SearchBackend {
  search(query: string): Promise<SearchFeed>;
  /** true/false from YouTube's oEmbed answer; null when it could not tell (network hiccup). */
  checkEmbeddable(videoId: string): Promise<boolean | null>;
  suggest(query: string): Promise<string[]>;
  /** Drop a YouTube session that started answering with empty pages. */
  resetSession?(): void;
}

// One shared Innertube instance (re-created if it starts failing).
let ytPromise: Promise<Innertube> | null = null;
function yt() {
  ytPromise ??= Innertube.create({ retrieve_player: false }).catch((err) => {
    ytPromise = null;
    throw err;
  });
  return ytPromise;
}

type YTSearch = Awaited<ReturnType<Innertube["search"]>>;

function wrapFeed(feed: YTSearch): SearchFeed {
  return {
    videos: feed.results
      .filterType(YTNodes.Video)
      .filter((v) => !v.is_live && !v.is_upcoming)
      .map((v) => ({
        videoId: v.video_id,
        title: v.title.toString(),
        channel: v.author?.name ?? "",
        duration: v.duration.text ?? "",
      })),
    next: feed.has_continuation ? async () => wrapFeed((await feed.getContinuation()) as YTSearch) : null,
  };
}

const youtubeBackend: SearchBackend = {
  async search(query) {
    return wrapFeed(await (await yt()).search(query, { type: "video" }));
  },
  // youtubei.js can't tell us whether a video plays in an IFrame, but YouTube's
  // oEmbed endpoint returns 401 when the uploader disabled embedding.
  async checkEmbeddable(videoId) {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`, { signal: AbortSignal.timeout(4000) });
      if (res.status === 200) return true;
      if (res.status === 401 || res.status === 403) return false;
    } catch {
      /* network hiccup: don't cache, assume playable */
    }
    return null;
  },
  async suggest(query) {
    return (await yt()).getSearchSuggestions(query);
  },
  resetSession() {
    ytPromise = null;
  },
};

let backend: SearchBackend = youtubeBackend;
let clock: () => number = Date.now;

/** Test seam: swap the YouTube side (and the clock) and start with an empty cache. Call with no arguments to restore. */
export function setSearchBackend(next?: SearchBackend, now?: () => number) {
  backend = next ?? youtubeBackend;
  clock = now ?? Date.now;
  cache.clear();
  embedCache.clear();
}

// ---------- the search cache ----------
// One entry per search text. It is an append-only list: videos are added in the order YouTube
// returned them and never removed or reordered, so "result #51" is always the same video and
// a page is just a slice. Whether a video can be embedded is decided once, when it is added.

export const MAX_PAGE_SIZE = 100;
const MAX_VIDEOS = 500; // per search; relevance falls off long before this
const MAX_PAGES = 25; // YouTube pages (about 20 videos each) per search
const TTL = 6 * 3600e3; // since the entry was last used
const MAX_QUERIES = 1000;
const SWEEP_EVERY = 10 * 60e3;

interface Entry {
  id: string; // the version: a new entry gets a new one
  at: number; // last used
  videos: VideoResult[];
  ids: Set<string>;
  feed: SearchFeed | null; // the last page fetched, which knows how to get the next one
  pages: number;
  done: boolean; // YouTube has no more
  lock: Promise<void>; // serialises page fetches for this query
}

const cache = new Map<string, Entry>(); // oldest use first

const canFetch = (e: Entry) => !e.done && e.pages < MAX_PAGES && e.videos.length < MAX_VIDEOS;

/** Remove searches nobody has used for a while. Runs on a timer; exported for tests. */
export function sweepSearchCache() {
  const now = clock();
  for (const [key, e] of cache) if (now - e.at > TTL) cache.delete(key);
}
setInterval(sweepSearchCache, SWEEP_EVERY).unref();

export const searchCacheSize = () => cache.size;

async function toResults(raw: RawVideo[], e: Entry): Promise<VideoResult[]> {
  const fresh = raw
    .filter((v) => !e.ids.has(v.videoId))
    .map((v) => ({ ...v, thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg` }));
  const flags = await Promise.all(fresh.map((v) => isEmbeddable(v.videoId)));
  fresh.forEach((v) => e.ids.add(v.videoId));
  return fresh.map((v, i) => ({ ...v, embeddable: flags[i] }));
}

/** Fetches the next page of YouTube results into the entry. */
async function fetchMore(e: Entry, q: string): Promise<void> {
  if (e.pages === 0) {
    const query = /karaoke/i.test(q) ? q : `${q} karaoke`;
    const attempt = async () => {
      const feed = await backend.search(query);
      return { feed, videos: await toResults(feed.videos, e) };
    };
    let { feed, videos } = await attempt();
    if (videos.length === 0) {
      // A stale YouTube session answers with an empty page instead of an error.
      console.warn(`search "${q}": no videos came back, retrying with a fresh YouTube session`);
      backend.resetSession?.();
      ({ feed, videos } = await attempt());
    }
    e.videos.push(...videos);
    e.feed = feed;
  } else {
    const next = e.feed?.next;
    if (!next) {
      e.done = true;
      return;
    }
    const feed = await next();
    e.videos.push(...(await toResults(feed.videos, e)));
    e.feed = feed;
  }
  e.pages++;
  if (!e.feed?.next) e.done = true;
}

const playable = (v: VideoResult) => v.embeddable !== false && embedCache.get(v.videoId) !== false;

/**
 * One page of results: `page` (0-based) of `pageSize`. With `playableOnly`, videos that can't be
 * embedded are left out and more YouTube pages are fetched to make up for them. A page past the
 * end gives the last page that exists (see `page` in the reply).
 */
export async function searchVideos(rawQuery: string, rawPage: number, rawPageSize: number, playableOnly: boolean): Promise<SearchPage> {
  const q = rawQuery.trim().replace(/\s+/g, " ").slice(0, 120);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(rawPageSize) || 25));
  const wanted = Math.max(0, Math.floor(rawPage) || 0);
  if (!q) return { results: [], page: 0, pageSize, total: 0, hasMore: false, hidden: 0, version: "" };

  const key = q.toLowerCase();
  let e = cache.get(key);
  if (e && clock() - e.at > TTL) {
    cache.delete(key);
    e = undefined;
  }
  if (!e) {
    if (cache.size >= MAX_QUERIES) cache.delete(cache.keys().next().value!);
    e = { id: randomUUID(), at: clock(), videos: [], ids: new Set(), feed: null, pages: 0, done: false, lock: Promise.resolve() };
  }
  e.at = clock();
  cache.delete(key); // re-insert: the map stays ordered by last use
  cache.set(key, e);

  const entry = e;
  const pool = () => (playableOnly ? entry.videos.filter((v) => v.embeddable !== false) : entry.videos);
  const need = (wanted + 1) * pageSize;

  // Fetch further pages until we have enough (one fetcher at a time per query).
  const run = entry.lock.then(async () => {
    while (pool().length < need && canFetch(entry)) {
      try {
        await fetchMore(entry, q);
      } catch (err) {
        if (entry.pages === 0) throw err; // the first page failing is the caller's problem
        console.warn("search continuation failed:", (err as Error).message);
        entry.done = true;
      }
    }
  });
  entry.lock = run.catch(() => {});
  try {
    await run;
  } catch (err) {
    backend.resetSession?.(); // force a fresh session next time
    if (cache.get(key) === entry) cache.delete(key);
    throw err;
  }
  if (entry.videos.length === 0 && cache.get(key) === entry) cache.delete(key); // never cache an empty answer

  const all = pool();
  const lastPage = Math.max(0, Math.ceil(all.length / pageSize) - 1);
  const page = Math.min(wanted, lastPage);
  const end = (page + 1) * pageSize;
  return {
    results: all.slice(page * pageSize, end).map((v) => (playable(v) ? v : { ...v, embeddable: false })),
    page,
    pageSize,
    total: all.length,
    hasMore: all.length > end || canFetch(entry),
    hidden: entry.videos.length - all.length,
    version: entry.id,
  };
}

export async function suggest(q: string): Promise<string[]> {
  const query = q.trim().slice(0, 80);
  if (!query) return [];
  return backend.suggest(query);
}

// ---------- embeddability ----------

const embedCache = new Map<string, boolean>();

export async function isEmbeddable(videoId: string): Promise<boolean> {
  const known = embedCache.get(videoId);
  if (known !== undefined) return known;
  const ok = await backend.checkEmbeddable(videoId);
  if (ok === null) return true;
  if (embedCache.size > 20000) embedCache.clear();
  embedCache.set(videoId, ok);
  return ok;
}

export const knownNotEmbeddable = (videoId: string) => embedCache.get(videoId) === false;

/** Called when a screen reports error 101/150 for a video oEmbed said was fine. */
export function markNotEmbeddable(videoId: string) {
  embedCache.set(videoId, false);
}

/** Undo a mark that turned out to be the screen's fault, not the video's. */
export function unmarkNotEmbeddable(videoId: string) {
  if (embedCache.get(videoId) === false) embedCache.delete(videoId);
}

/** Simple fixed-window rate limiter keyed by IP. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { start: number; count: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    return ++h.count <= limit;
  };
}

/** Title and channel of any video (oEmbed, no API key), for videos started on the TV itself. */
export async function videoInfo(videoId: string): Promise<{ title: string; channel: string } | null> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: string; author_name?: string };
    return { title: String(j.title ?? "").slice(0, 200), channel: String(j.author_name ?? "").slice(0, 100) };
  } catch {
    return null;
  }
}
