import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import type { LogLine } from "@karaoke/shared";

/**
 * Local log files (never a database):
 *
 *   <data>/logs/server-YYYY-MM-DD.log   the system log: one file per day, no size
 *                                       limit, files older than 30 days deleted
 *   <data>/logs/rooms/<CODE>.log        one room code's lines, at most 5 MB: when
 *                                       full, the oldest lines are dropped
 *
 * Everything written with console.log / warn / error is captured, so existing
 * code needs no changes. A line that starts with "[CODE] " (a room code) is also
 * written to that code's file. Room codes are reused, so a room file can hold
 * several rooms' lines over time (each begins with "room created").
 *
 * Line format: `<ISO time> <LEVEL> <message>` (message newlines are escaped).
 */
export const SYSTEM_LOG_KEEP_DAYS = 30;
export const ROOM_LOG_MAX_BYTES = 5 * 1024 * 1024;
const ROOM_PREFIX = /^\[([A-HJ-NP-Z2-9]{4})\] /;
const DAILY = /^server-(\d{4}-\d{2}-\d{2})\.log$/;
const DAY_MS = 24 * 3600e3;

type Level = LogLine["level"];

export interface LoggerOptions {
  systemKeepDays?: number;
  roomMaxBytes?: number;
}

/** Local calendar day, e.g. 2026-11-14 (a "day" of logs follows the server's clock). */
function dayOf(t: number | Date) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Logger {
  readonly dir: string;
  private roomDir: string;
  private keepDays: number;
  private roomMax: number;
  private chains = new Map<string, Promise<void>>(); // per-file write order
  private sizes = new Map<string, number>(); // room files only
  private today = "";

  constructor(dataDir: string, options: LoggerOptions = {}) {
    this.dir = path.join(dataDir, "logs");
    this.roomDir = path.join(this.dir, "rooms");
    this.keepDays = options.systemKeepDays ?? SYSTEM_LOG_KEEP_DAYS;
    this.roomMax = options.roomMaxBytes ?? ROOM_LOG_MAX_BYTES;
    mkdirSync(this.roomDir, { recursive: true });
    this.adoptLegacyFile();
    void this.pruneSystemLogs();
    // also prune while running, for servers that stay up for weeks
    setInterval(() => void this.pruneSystemLogs(), DAY_MS).unref();
  }

  /** Before daily files there was a single server.log: file it under its last day. */
  private adoptLegacyFile() {
    const legacy = path.join(this.dir, "server.log");
    try {
      if (!existsSync(legacy)) return;
      const target = this.systemFile(dayOf(statSync(legacy).mtime));
      if (!existsSync(target)) renameSync(legacy, target);
    } catch {
      // leave it where it is
    }
  }

  /** Route console output through the logger (and still print it). */
  captureConsole() {
    const wrap = (level: Level, original: (...a: unknown[]) => void) => (...args: unknown[]) => {
      original(...args);
      try {
        this.write(level, format(...args));
      } catch {
        // logging must never break the server
      }
    };
    console.log = wrap("info", console.log.bind(console));
    console.info = wrap("info", console.info.bind(console));
    console.warn = wrap("warn", console.warn.bind(console));
    console.error = wrap("error", console.error.bind(console));
  }

  write(level: Level, message: string, at = new Date()) {
    const line = `${at.toISOString()} ${level.toUpperCase().padEnd(5)} ${message.replace(/\r?\n/g, "\\n")}\n`;
    const day = dayOf(at);
    if (day !== this.today) {
      // a new day's file starts: drop the files that just aged out
      if (this.today) void this.pruneSystemLogs();
      this.today = day;
    }
    this.queue(this.systemFile(day), (file) => appendFile(file, line, "utf8"));
    const room = ROOM_PREFIX.exec(message)?.[1];
    if (room) this.queue(this.roomFile(room), (file) => this.appendCapped(file, line));
  }

  private systemFile(day: string) {
    return path.join(this.dir, `server-${day}.log`);
  }
  private roomFile(code: string) {
    return path.join(this.roomDir, `${code}.log`);
  }

  /** Run `work` after everything already queued for `file` (keeps lines in order). */
  private queue(file: string, work: (file: string) => Promise<void>) {
    const next = (this.chains.get(file) ?? Promise.resolve()).then(() => work(file)).catch(() => {}); // can't log a logging failure
    this.chains.set(file, next);
  }

  /**
   * Append to a room file that may never exceed the size limit. When the line
   * wouldn't fit, the oldest lines are dropped first (down to 80% of the limit,
   * so this rewrite happens once per megabyte or so, not on every line).
   */
  private async appendCapped(file: string, line: string) {
    const bytes = Buffer.byteLength(line);
    let size = this.sizes.get(file);
    if (size === undefined) size = await stat(file).then((s) => s.size, () => 0);
    if (size + bytes > this.roomMax) {
      const old = await readFile(file).catch(() => Buffer.alloc(0));
      const keep = Math.max(0, Math.floor(this.roomMax * 0.8) - bytes);
      let start = Math.max(0, old.length - keep);
      if (start > 0) {
        const nl = old.indexOf(0x0a, start); // continue from the next whole line
        start = nl === -1 ? old.length : nl + 1;
      }
      const kept = old.subarray(start);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, kept);
      await rename(tmp, file);
      size = kept.length;
    }
    await appendFile(file, line, "utf8");
    this.sizes.set(file, size + bytes);
  }

  /** Delete system log files older than the retention period. Returns how many went. */
  async pruneSystemLogs(now = Date.now()): Promise<number> {
    // keep today + the previous days (calendar days, so a DST change can't shift the cutoff)
    const d = new Date(now);
    const oldest = dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (this.keepDays - 1)));
    let removed = 0;
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const day = DAILY.exec(name)?.[1];
      if (day && day < oldest) {
        await unlink(path.join(this.dir, name)).then(() => removed++, () => {});
      }
    }
    return removed;
  }

  /** Days that have a system log file, newest first. */
  async systemDays(): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    return names
      .map((n) => DAILY.exec(n)?.[1])
      .filter((d): d is string => !!d)
      .sort()
      .reverse();
  }

  /**
   * The last `limit` lines, oldest first: of one room's log, of one day of the
   * system log (`day`), or of the system log's most recent days.
   */
  async tail(room: string | null, limit: number, day?: string): Promise<LogLine[]> {
    await Promise.all([...this.chains.values()]);
    let lines: string[] = [];
    if (room) {
      lines = (await readTail(this.roomFile(room), 1024 * 1024)).split("\n").filter(Boolean);
    } else {
      // newest file first, going back a day at a time until there are enough lines
      for (const d of day ? [day] : await this.systemDays()) {
        const more = (await readTail(this.systemFile(d), 1024 * 1024)).split("\n").filter(Boolean);
        lines = more.concat(lines);
        if (lines.length >= limit) break;
      }
    }
    return lines.slice(-limit).flatMap((l) => {
      const m = /^(\S+) (INFO|WARN|ERROR)\s+(.*)$/.exec(l);
      if (!m) return [];
      const at = Date.parse(m[1]);
      if (Number.isNaN(at)) return [];
      const message = m[3].replace(/\\n/g, "\n");
      const code = ROOM_PREFIX.exec(message)?.[1];
      return [{ at, level: m[2].toLowerCase() as Level, message, ...(code ? { room: code } : {}) }];
    });
  }

  /** Room codes that have a log file (live rooms and past ones). */
  async roomsWithLogs(): Promise<string[]> {
    const names = await readdir(this.roomDir).catch(() => [] as string[]);
    return names.filter((n) => /^[A-Z2-9]{4}\.log$/.test(n)).map((n) => n.slice(0, 4)).sort();
  }

  /** Total size of all log files, in bytes. */
  async totalBytes(): Promise<number> {
    let total = 0;
    for (const dir of [this.dir, this.roomDir]) {
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const s = await stat(path.join(dir, name)).catch(() => null);
        if (s?.isFile()) total += s.size;
      }
    }
    return total;
  }

  /** Wait until everything queued so far is on disk. */
  async flush() {
    await Promise.all([...this.chains.values()]);
    await mkdir(this.dir, { recursive: true });
  }
}

/** The last `maxBytes` of a file as text (whole lines only), or "" if it doesn't exist. */
async function readTail(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text; // drop the cut-off first line
  } finally {
    await handle.close();
  }
}
