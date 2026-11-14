import { mkdirSync, readFileSync } from "node:fs";
import { appendFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MetricPoint } from "@karaoke/shared";

/**
 * Server performance over time, for the admin debug page.
 *
 * One sample a minute, kept for 7 days (about 10,000 samples) in memory and in
 * `<data>/metrics/samples.jsonl`, so the history survives a restart. Older
 * samples are dropped at startup and once a day. Like the logs, this is a local
 * file, not a database.
 */
export const METRICS_KEEP_MS = 7 * 24 * 3600e3;
const DEFAULT_INTERVAL_MS = 60e3;

export interface MetricSample {
  at: number;
  /** Share of one CPU core used by the server since the previous sample (0-100+). */
  cpu: number;
  rss: number;
  heap: number;
  sockets: number;
  rooms: number;
  singers: number;
}

export interface LiveCounts {
  sockets: number;
  rooms: number;
  singers: number;
}

export class Metrics {
  private readonly file: string;
  private samples: MetricSample[] = [];
  private last = { at: Date.now(), usage: process.cpuUsage() };
  private chain: Promise<void> = Promise.resolve();
  readonly intervalMs: number;

  constructor(
    dataDir: string,
    private counts: () => LiveCounts,
  ) {
    const dir = path.join(dataDir, "metrics");
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "samples.jsonl");
    this.intervalMs = Math.max(1000, Number(process.env.KARAOKE_METRICS_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
    this.load();
  }

  private load() {
    const cutoff = Date.now() - METRICS_KEEP_MS;
    try {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const s = JSON.parse(line) as MetricSample;
          if (typeof s.at === "number" && s.at >= cutoff) this.samples.push(s);
        } catch {
          // half-written line after a crash
        }
      }
    } catch {
      // no history yet
    }
    this.compact();
  }

  start() {
    setTimeout(() => this.sample(), Math.min(5000, this.intervalMs)).unref(); // an early first point after a restart
    setInterval(() => this.sample(), this.intervalMs).unref();
    setInterval(() => this.compact(), 24 * 3600e3).unref();
  }

  private sample() {
    const now = Date.now();
    const usage = process.cpuUsage();
    const elapsedMs = Math.max(1, now - this.last.at);
    const usedMs = (usage.user - this.last.usage.user + (usage.system - this.last.usage.system)) / 1000;
    this.last = { at: now, usage };
    const mem = process.memoryUsage();
    const s: MetricSample = { at: now, cpu: Math.round((usedMs / elapsedMs) * 1000) / 10, rss: mem.rss, heap: mem.heapUsed, ...this.counts() };
    this.samples.push(s);
    const cutoff = now - METRICS_KEEP_MS;
    while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift();
    this.chain = this.chain.then(() => appendFile(this.file, JSON.stringify(s) + "\n", "utf8")).catch(() => {});
  }

  /** Rewrite the file with only the samples still inside the 7-day window. */
  private compact() {
    const cutoff = Date.now() - METRICS_KEEP_MS;
    this.samples = this.samples.filter((s) => s.at >= cutoff);
    const text = this.samples.map((s) => JSON.stringify(s)).join("\n") + (this.samples.length ? "\n" : "");
    const tmp = `${this.file}.tmp`;
    this.chain = this.chain
      .then(() => writeFile(tmp, text, "utf8"))
      .then(() => rename(tmp, this.file))
      .catch(() => {});
  }

  /**
   * The last `rangeMs` as at most `maxPoints` evenly spaced buckets, oldest
   * first. Buckets with no samples (the server was off) are left out, so the
   * chart can show the gap.
   */
  query(rangeMs: number, maxPoints = 240): { bucketMs: number; from: number; to: number; points: MetricPoint[]; systemMemory: number } {
    const to = Date.now();
    const range = Math.max(this.intervalMs, Math.min(rangeMs, METRICS_KEEP_MS));
    const from = to - range;
    const bucketMs = Math.max(this.intervalMs, Math.ceil(range / maxPoints / this.intervalMs) * this.intervalMs);
    const buckets = new Map<number, MetricSample[]>();
    for (const s of this.samples) {
      if (s.at < from) continue;
      const key = Math.floor((s.at - from) / bucketMs);
      const list = buckets.get(key);
      if (list) list.push(s);
      else buckets.set(key, [s]);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const points = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, list]): MetricPoint => ({
        at: Math.round(avg(list.map((s) => s.at))),
        cpu: Math.round(avg(list.map((s) => s.cpu)) * 10) / 10,
        cpuMax: Math.max(...list.map((s) => s.cpu)),
        rss: Math.round(avg(list.map((s) => s.rss))),
        heap: Math.round(avg(list.map((s) => s.heap))),
        sockets: Math.max(...list.map((s) => s.sockets)),
        rooms: Math.max(...list.map((s) => s.rooms)),
        singers: Math.max(...list.map((s) => s.singers)),
      }));
    return { bucketMs, from, to, points, systemMemory: os.totalmem() };
  }
}
