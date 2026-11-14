import { appendFile, mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import type { LogLine } from "@karaoke/shared";

/**
 * Local log files (never a database):
 *
 *   <data>/logs/server.log          every line
 *   <data>/logs/rooms/<CODE>.log    lines for one room
 *
 * Everything written with console.log / warn / error is captured, so existing
 * code needs no changes. A line that starts with "[CODE] " (a room code) is also
 * written to that room's file. Each file rotates to "<name>.1" at 5 MB.
 *
 * Line format: `<ISO time> <LEVEL> <message>` (message newlines are escaped).
 */
const MAX_BYTES = 5 * 1024 * 1024;
const ROOM_PREFIX = /^\[([A-HJ-NP-Z2-9]{4})\] /;

type Level = LogLine["level"];

export class Logger {
  readonly dir: string;
  private roomDir: string;
  private chains = new Map<string, Promise<void>>(); // per-file write order
  private sizes = new Map<string, number>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "logs");
    this.roomDir = path.join(this.dir, "rooms");
    mkdirSync(this.roomDir, { recursive: true });
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

  write(level: Level, message: string) {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message.replace(/\r?\n/g, "\\n")}\n`;
    this.append(path.join(this.dir, "server.log"), line);
    const room = ROOM_PREFIX.exec(message)?.[1];
    if (room) this.append(this.roomFile(room), line);
  }

  private roomFile(code: string) {
    return path.join(this.roomDir, `${code}.log`);
  }

  private append(file: string, line: string) {
    const prev = this.chains.get(file) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        let size = this.sizes.get(file);
        if (size === undefined) size = await stat(file).then((s) => s.size, () => 0);
        if (size + line.length > MAX_BYTES) {
          await rename(file, `${file}.1`).catch(() => {});
          size = 0;
        }
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, line, "utf8");
        this.sizes.set(file, size + Buffer.byteLength(line));
      })
      .catch(() => {}); // can't log a logging failure
    this.chains.set(file, next);
  }

  /** The last `limit` lines of the system log (or one room's log), oldest first. */
  async tail(room: string | null, limit: number): Promise<LogLine[]> {
    const file = room ? this.roomFile(room) : path.join(this.dir, "server.log");
    await (this.chains.get(file) ?? Promise.resolve());
    const text = (await readTail(`${file}.1`, 256 * 1024)) + (await readTail(file, 512 * 1024));
    const lines = text.split("\n").filter(Boolean).slice(-limit);
    return lines.flatMap((l) => {
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
