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
  suggestCache.clear();
  fetchLog.length = 0;
  backoffUntil = 0;
  Object.assign(searchLimits, defaultLimits());
}

// ---------- the search cache ----------
// One entry per search text. It is an append-only list: videos are added in the order YouTube
// returned them and never removed or reordered, so "result #51" is always the same video and
// a page is just a slice. Whether a video can be embedded is decided once, when it is added.

export const MAX_PAGE_SIZE = 100;
const MAX_VIDEOS = 250; // per search; relevance falls off long before this
const MAX_PAGES = 13; // YouTube pages (about 20 videos each) per search
const TTL = 6 * 3600e3; // since the entry was last used
const MAX_QUERIES = 300; // enough for a party of 50 over the cache's whole life
const SWEEP_EVERY = 10 * 60e3;
const FAILURE_PAUSE = 5000; // after YouTube fails, leave it alone for a moment

/** What protects YouTube (and the home connection) from being asked too much. Tests change these. */
const defaultLimits = () => ({
  budgetPerMin: Number(process.env.KARAOKE_YT_BUDGET_PER_MIN) || 80, // YouTube page fetches a minute, all guests together
  maxFetchesPerRequest: 8, // one request (a page jump) may fetch at most this many YouTube pages
  embedConcurrency: 5, // oEmbed checks in flight at once
  prefetchBelow: 0.5, // look one page ahead only while less than this share of the budget is used
  perPhoneShare: 0.25, // one phone's searches may use at most this share of the budget a minute
});
export const searchLimits = defaultLimits();

const fetchLog: { at: number; who?: string }[] = []; // each YouTube page fetched in the last minute, and for whom
let backoffUntil = 0;

/** YouTube is being asked too much (or just failed): answer "busy" instead of asking again. */
export class SearchBusyError extends Error {
  constructor() {
    super("Search is busy, try again in a moment.");
  }
}

/**
 * Takes one YouTube page fetch from the shared budget; false when none is left, when YouTube just
 * failed, or when this phone (`who`) has already used its share of the minute.
 */
function takeBudget(maxShare = 1, who?: string): boolean {
  const now = clock();
  while (fetchLog.length && now - fetchLog[0]!.at > 60e3) fetchLog.shift();
  if (now < backoffUntil) return false;
  if (fetchLog.length >= searchLimits.budgetPerMin * maxShare) return false;
  if (who !== undefined) {
    const mine = fetchLog.reduce((n, f) => (f.who === who ? n + 1 : n), 0);
    if (mine >= Math.max(2, Math.ceil(searchLimits.budgetPerMin * searchLimits.perPhoneShare))) return false;
  }
  fetchLog.push({ at: now, who });
  return true;
}
const failed = () => {
  backoffUntil = clock() + FAILURE_PAUSE;
};

interface Entry {
  id: string; // the version: a new entry gets a new one
  at: number; // last used
  videos: VideoResult[]; // embeddable is filled in, in order, for the first `checked` of them
  checked: number;
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
  for (const [key, s] of suggestCache) if (now - s.at > SUGGEST_TTL) suggestCache.delete(key);
}
setInterval(sweepSearchCache, SWEEP_EVERY).unref();

export const searchCacheSize = () => cache.size;

function toResults(raw: RawVideo[], e: Entry): VideoResult[] {
  const fresh = raw.filter((v) => !e.ids.has(v.videoId)).map((v) => ({ ...v, thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg` }));
  fresh.forEach((v) => e.ids.add(v.videoId));
  return fresh;
}

/** Decides, in order, whether the next few videos can be embedded (a few at a time, never all at once). */
async function checkNext(e: Entry): Promise<void> {
  const batch = e.videos.slice(e.checked, e.checked + searchLimits.embedConcurrency);
  const flags = await Promise.all(batch.map((v) => isEmbeddable(v.videoId)));
  batch.forEach((v, i) => (v.embeddable = flags[i]));
  e.checked += batch.length;
}

/** Fetches the next page of YouTube results into the entry. */
async function fetchMore(e: Entry, q: string): Promise<void> {
  if (e.pages === 0) {
    const query = /karaoke/i.test(q) ? q : `${q} karaoke`;
    const attempt = async () => {
      const feed = await backend.search(query);
      return { feed, videos: toResults(feed.videos, e) };
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
    e.videos.push(...toResults(feed.videos, e));
    e.feed = feed;
  }
  e.pages++;
  if (!e.feed?.next) e.done = true;
}

const playable = (v: VideoResult) => v.embeddable !== false && embedCache.get(v.videoId) !== false;

/**
 * One page of results: `page` (0-based) of `pageSize`. With `playableOnly`, videos that can't be
 * embedded are left out and more YouTube pages are fetched to make up for them. A page past the
 * end gives the last page that exists (see `page` in the reply). `who` (the phone asking) limits how
 * much of the shared YouTube budget these searches may use, so one guest can't take it all.
 */
export async function searchVideos(rawQuery: string, rawPage: number, rawPageSize: number, playableOnly: boolean, who?: string): Promise<SearchPage> {
  const q = rawQuery.trim().replace(/\s+/g, " ").slice(0, 120);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(rawPageSize) || 25));
  const wanted = Math.max(0, Math.floor(rawPage) || 0);
  if (!q) return { results: [], page: 0, pageSize, total: 0, complete: true, hasMore: false, hidden: 0, version: "" };

  const key = q.toLowerCase();
  let e = cache.get(key);
  if (e && clock() - e.at > TTL) {
    cache.delete(key);
    e = undefined;
  }
  if (!e) {
    if (cache.size >= MAX_QUERIES) cache.delete(cache.keys().next().value!);
    e = { id: randomUUID(), at: clock(), videos: [], checked: 0, ids: new Set(), feed: null, pages: 0, done: false, lock: Promise.resolve() };
  }
  e.at = clock();
  cache.delete(key); // re-insert: the map stays ordered by last use
  cache.set(key, e);

  const entry = e;
  const need = (wanted + 1) * pageSize;
  let busy = false;

  // Fetch (and check) further videos until we have enough (one fetcher at a time per query).
  const run = entry.lock.then(async () => {
    busy = await fill(entry, q, need, playableOnly, 1, searchLimits.maxFetchesPerRequest, who);
  });
  entry.lock = run.catch(() => {});
  try {
    await run;
  } catch (err) {
    backend.resetSession?.(); // force a fresh session next time
    failed();
    if (cache.get(key) === entry) cache.delete(key);
    throw err;
  }
  if (entry.videos.length === 0 && cache.get(key) === entry) cache.delete(key); // never cache an empty answer
  if (busy && entry.videos.length === 0) throw new SearchBusyError();

  const all = poolOf(entry, playableOnly);
  const lastPage = Math.max(0, Math.ceil(all.length / pageSize) - 1);
  const page = Math.min(wanted, lastPage);
  const end = (page + 1) * pageSize;
  if (all.length >= need) prefetch(entry, q, (wanted + 2) * pageSize, playableOnly, who); // the page after this one, for the Next button
  return {
    results: all.slice(page * pageSize, end).map((v) => (playable(v) ? v : { ...v, embeddable: false })),
    page,
    pageSize,
    total: all.length,
    complete: !canFetch(entry),
    hasMore: all.length > end || canFetch(entry),
    hidden: playableOnly ? entry.checked - all.length : 0,
    version: entry.id,
    ...(busy && all.length < need ? { busy: true } : {}),
  };
}

/** The results a request can use: when filtering, only the videos already checked, in order. */
const poolOf = (e: Entry, playableOnly: boolean) => (playableOnly ? e.videos.slice(0, e.checked).filter((v) => v.embeddable !== false) : e.videos);

/**
 * Grows the entry until `need` results are usable or nothing more can be had. Returns true when it
 * stopped because the YouTube budget ran out. `share` is how much of the budget this may use
 * (1 = all of it); `maxFetches` limits the YouTube pages one call may fetch.
 */
async function fill(e: Entry, q: string, need: number, playableOnly: boolean, share: number, maxFetches: number, who?: string): Promise<boolean> {
  let fetches = 0;
  while (poolOf(e, playableOnly).length < need) {
    if (playableOnly && e.checked < e.videos.length) {
      await checkNext(e);
      continue;
    }
    if (!canFetch(e) || fetches >= maxFetches) return false;
    if (!takeBudget(share, who)) return true;
    fetches++;
    try {
      await fetchMore(e, q);
    } catch (err) {
      if (e.pages === 0) throw err; // the first page failing is the caller's problem
      console.warn("search continuation failed:", (err as Error).message);
      e.done = true;
      failed();
    }
  }
  return false;
}

/** Quietly fetches one page ahead after answering, while the shared budget is mostly free. */
function prefetch(e: Entry, q: string, need: number, playableOnly: boolean, who?: string) {
  const run = e.lock.then(async () => {
    if (poolOf(e, playableOnly).length >= need) return;
    await fill(e, q, need, playableOnly, searchLimits.prefetchBelow, 2, who);
  });
  e.lock = run.catch(() => {});
}

/** Resolves when no search is still fetching in the background (for tests). */
export const searchIdle = async () => {
  await Promise.all([...cache.values()].map((e) => e.lock));
};

// Autocomplete runs as people type, so many phones ask for the same few starts: remember the answers.
const SUGGEST_TTL = 5 * 60e3;
const MAX_SUGGESTIONS = 500;
const suggestCache = new Map<string, { at: number; list: Promise<string[]> }>();

export async function suggest(q: string): Promise<string[]> {
  const query = q.trim().slice(0, 80);
  if (!query) return [];
  const key = query.toLowerCase();
  const known = suggestCache.get(key);
  if (known && clock() - known.at <= SUGGEST_TTL) return known.list;
  const list = backend.suggest(query);
  if (suggestCache.size >= MAX_SUGGESTIONS) suggestCache.delete(suggestCache.keys().next().value!);
  suggestCache.set(key, { at: clock(), list });
  list.catch(() => suggestCache.delete(key)); // never remember a failure
  return list;
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
