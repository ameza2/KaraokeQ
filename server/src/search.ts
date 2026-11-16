import { Innertube, YTNodes } from "youtubei.js";
import type { SearchPage, VideoResult } from "@karaoke/shared";

export const MAX_RESULTS = 100;
const MAX_PAGES = 12; // YouTube returns ~20 per page; leave headroom for filtering
const TTL = 6 * 3600e3;
const MAX_QUERIES = 1000;

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

interface Entry {
  at: number;
  videos: VideoResult[];
  ids: Set<string>;
  feed: YTSearch | null; // last page fetched; null = exhausted
  pages: number;
  lock: Promise<void>; // serialises page fetches for this query
}

const cache = new Map<string, Entry>();

async function toResults(feed: YTSearch, entry: Entry): Promise<VideoResult[]> {
  const fresh = feed.results
    .filterType(YTNodes.Video)
    .filter((v) => !v.is_live && !v.is_upcoming && !entry.ids.has(v.video_id))
    .map((v) => ({
      videoId: v.video_id,
      title: v.title.toString(),
      channel: v.author?.name ?? "",
      duration: v.duration.text ?? "",
      thumb: `https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg`,
    }));
  const flags = await Promise.all(fresh.map((v) => isEmbeddable(v.videoId)));
  fresh.forEach((v) => entry.ids.add(v.videoId));
  return fresh.map((v, i) => ({ ...v, embeddable: flags[i] }));
}

const playable = (v: VideoResult) => v.embeddable !== false && embedCache.get(v.videoId) !== false;

/**
 * Returns up to `limit` results (max 100). With `playableOnly`, videos that
 * can't be embedded are dropped and more pages are fetched to make up for them.
 */
export async function searchVideos(rawQuery: string, rawLimit: number, playableOnly: boolean): Promise<SearchPage> {
  const q = rawQuery.trim().replace(/\s+/g, " ").slice(0, 120);
  const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(rawLimit) || 25));
  if (!q) return { results: [], hasMore: false, hidden: 0 };

  const key = q.toLowerCase();
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > TTL) {
    if (cache.size >= MAX_QUERIES) cache.delete(cache.keys().next().value!);
    entry = { at: Date.now(), videos: [], ids: new Set(), feed: null, pages: 0, lock: Promise.resolve() };
    cache.set(key, entry);
    const e = entry;
    e.lock = (async () => {
      const query = /karaoke/i.test(q) ? q : `${q} karaoke`;
      try {
        const feed = await (await yt()).search(query, { type: "video" });
        e.videos.push(...(await toResults(feed, e)));
        e.feed = feed.has_continuation ? feed : null;
        e.pages = 1;
      } catch (err) {
        ytPromise = null; // force a fresh session next time
        cache.delete(key);
        throw err;
      }
    })();
  }

  const e = entry;
  const count = () => (playableOnly ? e.videos.filter(playable).length : e.videos.length);

  // Fetch further pages until we have enough (one fetcher at a time per query).
  const run = e.lock.then(async () => {
    while (count() < limit && e.feed && e.pages < MAX_PAGES) {
      try {
        const next = (await e.feed.getContinuation()) as YTSearch;
        e.videos.push(...(await toResults(next, e)));
        e.feed = next.has_continuation ? next : null;
      } catch (err) {
        console.warn("search continuation failed:", (err as Error).message);
        e.feed = null;
      }
      e.pages++;
    }
  });
  e.lock = run.catch(() => {});
  await run;

  const pool = playableOnly ? e.videos.filter(playable) : e.videos;
  const results = pool.slice(0, limit).map((v) => (playable(v) ? v : { ...v, embeddable: false }));
  const canFetchMore = !!e.feed && e.pages < MAX_PAGES;
  return {
    results,
    hasMore: limit < MAX_RESULTS && (pool.length > limit || canFetchMore),
    hidden: e.videos.length - pool.length,
  };
}

export async function suggest(q: string): Promise<string[]> {
  const query = q.trim().slice(0, 80);
  if (!query) return [];
  return (await yt()).getSearchSuggestions(query);
}

// ---------- embeddability ----------
// youtubei.js can't tell us whether a video plays in an IFrame, but YouTube's
// oEmbed endpoint returns 401 when the uploader disabled embedding.

const embedCache = new Map<string, boolean>();

async function isEmbeddable(videoId: string): Promise<boolean> {
  const known = embedCache.get(videoId);
  if (known !== undefined) return known;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (res.status === 200 || res.status === 401 || res.status === 403) {
      const ok = res.status === 200;
      if (embedCache.size > 20000) embedCache.clear();
      embedCache.set(videoId, ok);
      return ok;
    }
  } catch {
    /* network hiccup: don't cache, assume playable */
  }
  return true;
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
