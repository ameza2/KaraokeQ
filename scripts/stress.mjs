// Stress test for search: pretend phones search, page and type against a server whose YouTube is
// made up (KARAOKE_FAKE_YOUTUBE=1), and count what reaches the fake YouTube. No network, so it
// can't get your real IP throttled. Run: npm run stress   (STRESS_SECONDS=60 changes the party length)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECONDS = Number(process.env.STRESS_SECONDS) || 60;
const BUDGET = Number(process.env.KARAOKE_YT_BUDGET_PER_MIN) || 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a small seeded random generator, so two runs behave alike
let seed = Number(process.env.STRESS_SEED) || 7;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (a, b) => a + rand() * (b - a);

const POPULAR = ["bohemian rhapsody", "dont stop believin", "sweet caroline", "livin on a prayer", "mr brightside", "wonderwall", "i will survive", "shallow"];

// ---------- a server per phase, so the shared budget starts full each time ----------
async function startServer(env = {}) {
  const port = 4100 + Math.floor(rand() * 800);
  const dataDir = mkdtempSync(path.join(tmpdir(), "karaoke-stress-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: path.join(repo, "server"),
    env: { ...process.env, PORT: String(port), KARAOKE_DATA_DIR: dataDir, KARAOKE_FAKE_YOUTUBE: "1", KARAOKE_FAKE_SEARCH_MS: "250", KARAOKE_FAKE_EMBED_MS: "150", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 150 && !log.includes("listening"); i++) await sleep(200);
  if (!log.includes("listening")) throw new Error("server did not start:\n" + log);
  return { port, stop: () => child.kill(), log: () => log };
}

// Every phone gets its own address (127.0.0.N), like phones on a home network, so the
// server's per-phone limits apply to each one separately.
function get(port, ip, url) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: url, localAddress: ip, agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - t0, body }));
    });
    req.on("error", () => resolve({ status: 0, ms: performance.now() - t0, body: "" }));
    req.setTimeout(20000, () => req.destroy());
  });
}
const phoneIp = (n) => `127.0.0.${10 + n}`;

// ---------- measuring ----------
function newTally() {
  return { calls: [], byStatus: {} };
}
function record(tally, kind, r) {
  tally.calls.push({ kind, ...r });
  tally.byStatus[r.status] = (tally.byStatus[r.status] ?? 0) + 1;
}
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);
const fmt = (n) => Math.round(n);

async function fakeStats(port) {
  return JSON.parse((await get(port, phoneIp(0), "/api/_fake-youtube")).body);
}

// ---------- a phone ----------
async function searchOnce(port, n, tally, q, opts = {}) {
  const ip = phoneIp(n);
  const size = opts.size ?? pick([10, 25, 25, 25, 50]);
  for (const len of [3, 6, q.length]) if (q.length >= len) { // autocomplete while typing
    record(tally, "suggest", await get(port, ip, `/api/suggest?q=${encodeURIComponent(q.slice(0, len))}`));
    await sleep(opts.fast ? 20 : 300);
  }
  let page = 0;
  const pages = opts.pages ?? 1 + Math.min(4, Math.floor(-Math.log(1 - rand()) / Math.log(2)));
  for (let i = 0; i < pages; i++) {
    const r = await get(port, ip, `/api/search?q=${encodeURIComponent(q)}&page=${page}&pageSize=${size}`);
    record(tally, "search", r);
    if (r.status !== 200) break;
    const body = JSON.parse(r.body);
    if (!body.hasMore) break;
    page = body.page + (rand() < 0.1 ? 3 : 1); // now and then a « » jump
    await sleep(opts.fast ? 0 : between(1000, 3000));
  }
}

/** A guest: searches, browses a few pages, then waits `[min, max]` ms before the next search. */
async function phone(port, n, tally, until, [min, max]) {
  await sleep(between(0, min)); // phones don't all start at the same moment
  while (Date.now() < until) {
    const q = rand() < 0.6 ? pick(POPULAR) : `song ${Math.floor(rand() * 99999)}`;
    await searchOnce(port, n, tally, q);
    await sleep(between(min, max));
  }
}

function report(name, tally, stats, seconds) {
  const searches = tally.calls.filter((c) => c.kind === "search");
  const ok = searches.filter((c) => c.status === 200);
  const lat = ok.map((c) => c.ms);
  const fetches = stats.searches + stats.continuations;
  const busy = searches.filter((c) => c.status === 503).length;
  const limited = searches.filter((c) => c.status === 429).length;
  const failed = searches.filter((c) => ![200, 503, 429].includes(c.status)).length;
  const suggests = tally.calls.filter((c) => c.kind === "suggest").length;
  console.log(`\n== ${name} (${seconds}s) ==`);
  console.log(`  searches ${searches.length}: ${ok.length} ok, ${busy} busy (503), ${limited} limited (429), ${failed} failed`);
  console.log(`  response time ok: median ${fmt(pct(lat, 50))} ms, 95th percentile ${fmt(pct(lat, 95))} ms`);
  console.log(`  YouTube page fetches ${fetches} (${(fetches / (seconds / 60)).toFixed(1)} a minute), embed checks ${stats.embedChecks}, suggest calls ${stats.suggests} for ${suggests} typed`);
  console.log(`  searches answered without a new YouTube page: ${ok.length ? Math.round((1 - Math.min(1, fetches / ok.length)) * 100) : 0}%`);
  console.log(`  server memory ${stats.rssMb} MB (heap ${stats.heapMb} MB), ${stats.cachedSearches} searches cached`);
  return { searches, ok, busy, limited, failed, fetches, lat, stats };
}

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
};
const findings = [];

// ================= phase 1: a normal party =================
// Each guest searches about every 15-45 seconds (60% sing the same popular songs) and browses a few pages.
{
  const s = await startServer();
  const tally = newTally();
  const until = Date.now() + SECONDS * 1000;
  await Promise.all(Array.from({ length: 50 }, (_, n) => phone(s.port, n + 1, tally, until, [15000, 45000])));
  const stats = await fakeStats(s.port);
  const r = report("a normal party: 50 phones, a search every 15-45 s", tally, stats, SECONDS);
  const minutes = Math.ceil(SECONDS / 60);
  check("steady: YouTube page fetches stay within the shared budget", r.fetches <= BUDGET * minutes + 2, `${r.fetches} <= ${BUDGET * minutes + 2}`);
  check("steady: no search failed outright", r.failed === 0, `${r.failed} failed`);
  check("steady: cached pages answer quickly (median under 400 ms)", pct(r.lat, 50) < 400, `${fmt(pct(r.lat, 50))} ms`);
  check("steady: memory stays reasonable (under 300 MB)", stats.rssMb < 300, `${stats.rssMb} MB`);
  const busyShare = r.searches.length ? r.busy / r.searches.length : 0;
  // A warning, not a failure: a short run is mostly cold cache, so this measures the first minutes of a party.
  console.log(`  'busy' share: ${(busyShare * 100).toFixed(1)}% (warning above 5%)`);
  if (busyShare >= 0.05) findings.push(`In the first minutes of a party of 50 (cold cache), ${(busyShare * 100).toFixed(0)}% of searches answered "busy" with a budget of ${BUDGET} a minute: raise KARAOKE_YT_BUDGET_PER_MIN if that feels tight.`);
  s.stop();
}

// ================= phase 1b: a hard party =================
// Every guest searches again every 1-5 seconds: far more than people really do.
{
  const s = await startServer();
  const tally = newTally();
  const seconds = 30;
  const until = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: 50 }, (_, n) => phone(s.port, n + 1, tally, until, [1000, 5000])));
  const stats = await fakeStats(s.port);
  const r = report("worst case: 50 phones, a search every 1-5 s", tally, stats, seconds);
  check("worst case: YouTube page fetches still stay within the budget", r.fetches <= BUDGET + 2, `${r.fetches} <= ${BUDGET + 2}`);
  check("worst case: no search failed outright", r.failed === 0, `${r.failed} failed`);
  check("worst case: memory stays reasonable (under 300 MB)", stats.rssMb < 300, `${stats.rssMb} MB`);
  const share = r.searches.length ? r.busy / r.searches.length : 0;
  console.log(`  ${(share * 100).toFixed(0)}% of searches got 'busy' (new searches wait for the budget; cached pages still work)`);
  s.stop();
}

// ================= phase 2: everyone searches the same song =================
{
  const s = await startServer();
  const tally = newTally();
  for (let round = 0; round < 5; round++) {
    await Promise.all(Array.from({ length: 30 }, (_, n) => searchOnce(s.port, n + 1, tally, POPULAR[round], { fast: true, pages: 2, size: 25 })));
  }
  const stats = await fakeStats(s.port);
  const r = report("30 phones search the same song, 5 songs in a row", tally, stats, 10);
  check("same song: 150 searches cost about one YouTube search per song", stats.searches <= 5, `${stats.searches} YouTube searches`);
  check("same song: every phone got an answer", r.ok.length === r.searches.length, `${r.ok.length}/${r.searches.length}`);
  check("same song: autocomplete shared too (suggest calls under 30)", stats.suggests < 30, `${stats.suggests} calls for ${tally.calls.filter((c) => c.kind === "suggest").length} typed`);
  s.stop();
}

// ================= phase 3: one phone mashes Next while another searches =================
{
  const s = await startServer();
  const masher = newTally();
  const bystander = newTally();
  const until = Date.now() + 40 * 1000;
  const mash = (async () => {
    let page = 0;
    while (Date.now() < until) {
      const r = await get(s.port, phoneIp(1), `/api/search?q=endless%20ballad&page=${page}&pageSize=25`);
      record(masher, "search", r);
      if (r.status === 200) page = JSON.parse(r.body).page + 3;
      else await sleep(200);
    }
  })();
  const watcher = (async () => {
    let i = 0;
    await sleep(3000);
    while (Date.now() < until) {
      record(bystander, "search", await get(s.port, phoneIp(2), `/api/search?q=${encodeURIComponent("quiet song " + i++)}&page=0&pageSize=25`));
      await sleep(2500);
    }
  })();
  await Promise.all([mash, watcher]);
  const stats = await fakeStats(s.port);
  report("one phone mashing » while another searches", masher, stats, 40);
  const bys = bystander.calls.filter((c) => c.kind === "search");
  const answered = bys.filter((c) => c.status === 200 || c.status === 503);
  const ok = bys.filter((c) => c.status === 200).length;
  console.log(`  the other phone: ${ok} of ${bys.length} searches answered normally, ${bys.length - ok} busy`);
  check("mashing: the other phone always gets an answer (never hangs or errors)", answered.length === bys.length, `${answered.length}/${bys.length}`);
  check("mashing: YouTube fetches stay within the budget", stats.searches + stats.continuations <= BUDGET + 2, `${stats.searches + stats.continuations} <= ${BUDGET + 2}`);
  if (ok < bys.length) findings.push(`One phone mashing » made ${bys.length - ok} of ${bys.length} searches from another phone answer "busy" (the budget is shared by everyone). A per-phone share of the budget would stop one guest taking it all.`);
  s.stop();
}

// ================= phase 4: 50 new searches at once =================
{
  const s = await startServer();
  const tally = newTally();
  await Promise.all(Array.from({ length: 50 }, (_, n) => searchOnce(s.port, n + 1, tally, `brand new song ${n}`, { fast: true, pages: 1, size: 25 })));
  const stats = await fakeStats(s.port);
  const r = report("50 phones start a different search at the same moment", tally, stats, 10);
  check("burst: YouTube fetches stay within the budget", stats.searches + stats.continuations <= BUDGET + 2, `${stats.searches + stats.continuations} <= ${BUDGET + 2}`);
  check("burst: every phone got an answer (a result or 'busy')", r.ok.length + r.busy === r.searches.length, `${r.ok.length} ok + ${r.busy} busy of ${r.searches.length}`);
  check("burst: the server is still fine afterwards", (await get(s.port, phoneIp(0), "/api/info")).status === 200);
  if (r.busy > 0) findings.push(`A burst of 50 different searches got ${r.busy} "busy" answers: expected, but they retry after the minute window. Fine for a party; raise the budget if it feels tight.`);
  s.stop();
}

console.log("\n" + (findings.length ? "Findings:\n- " + findings.join("\n- ") : "Findings: none"));
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
