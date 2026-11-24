import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomicWrite.ts";

/**
 * Lockout for devices that keep guessing secrets (admin password, room codes, screen codes).
 *
 * A device is its network address. Failures are counted in a row per scope (so a wrong admin
 * password and a wrong room code are tracked separately) and a success clears the count:
 *  - from the 5th failure in a row the device is banned for 5 minutes (each further failure
 *    after the ban ends starts another 5 minutes);
 *  - at the 10th failure in a row it is banned for good, in every scope.
 *
 * Permanent bans live in `<data>/blocklist.json`. To let a device back in, delete its entry
 * from that file: the change is picked up within a few seconds, no restart needed.
 */
export interface BlockOptions {
  /** Failures in a row that start a temporary ban. */
  tempAfter?: number;
  /** Failures in a row that ban for good. */
  permanentAfter?: number;
  tempMs?: number;
  /** How often the file is checked for manual edits. */
  recheckMs?: number;
  now?: () => number;
}

export type BlockStatus = { blocked: false } | { blocked: true; permanent: true } | { blocked: true; permanent: false; retryAfterMs: number };

interface Entry {
  key: string;
  since: string;
  scope: string;
}

interface Counter {
  fails: number;
  until: number;
}

const MAX_COUNTERS = 10_000;

/** What to tell a device that is locked out. */
export function blockMessage(s: BlockStatus): string {
  if (!s.blocked) return "";
  if (s.permanent) return "This device is blocked. Ask whoever runs the server to unblock it.";
  const min = Math.max(1, Math.ceil(s.retryAfterMs / 60e3));
  return `Too many wrong attempts. Try again in ${min} minute${min === 1 ? "" : "s"}.`;
}

/** One address, whichever way the socket spells it ("::ffff:1.2.3.4" is 1.2.3.4). */
export const deviceKey = (address: string | undefined) => (address ?? "?").replace(/^::ffff:/i, "").toLowerCase();

export class Blocklist {
  readonly file: string;
  private permanent = new Map<string, Entry>();
  private counters = new Map<string, Counter>();
  private seen = "";
  private checkedAt = 0;
  private readonly tempAfter: number;
  private readonly permanentAfter: number;
  private readonly tempMs: number;
  private readonly recheckMs: number;
  private readonly now: () => number;

  constructor(dataDir: string, opts: BlockOptions = {}) {
    this.file = path.join(dataDir, "blocklist.json");
    this.tempAfter = opts.tempAfter ?? 5;
    this.permanentAfter = opts.permanentAfter ?? 10;
    this.tempMs = opts.tempMs ?? 5 * 60e3;
    this.recheckMs = opts.recheckMs ?? 3000;
    this.now = opts.now ?? Date.now;
    this.reload();
  }

  /** Is this device locked out of `scope` right now? Check this before looking at the secret. */
  status(scope: string, address: string | undefined): BlockStatus {
    this.refresh();
    const key = deviceKey(address);
    if (this.permanent.has(key)) return { blocked: true, permanent: true };
    const until = this.counters.get(`${scope}|${key}`)?.until ?? 0;
    const left = until - this.now();
    return left > 0 ? { blocked: true, permanent: false, retryAfterMs: left } : { blocked: false };
  }

  /** A wrong guess. Does nothing for a device that is already blocked. */
  fail(scope: string, address: string | undefined): BlockStatus {
    const key = deviceKey(address);
    const before = this.status(scope, address);
    if (before.blocked) return before;

    const id = `${scope}|${key}`;
    const c = this.counters.get(id) ?? { fails: 0, until: 0 };
    c.fails += 1;
    this.counters.delete(id); // re-insert so the oldest entries come first
    this.counters.set(id, c);
    if (this.counters.size > MAX_COUNTERS) this.counters.delete(this.counters.keys().next().value as string);

    if (c.fails >= this.permanentAfter) {
      this.counters.delete(id);
      this.ban(key, scope);
    } else if (c.fails >= this.tempAfter) {
      c.until = this.now() + this.tempMs;
      console.warn(`blocklist: ${key} is blocked for ${Math.round(this.tempMs / 60e3)} min (${c.fails} wrong ${scope} attempts in a row)`);
    }
    return this.status(scope, address);
  }

  /** A correct guess: the run of failures starts over. */
  succeed(scope: string, address: string | undefined) {
    this.counters.delete(`${scope}|${deviceKey(address)}`);
  }

  /** Permanently blocked devices, for the admin and tests. */
  list(): Entry[] {
    this.refresh();
    return [...this.permanent.values()];
  }

  /** Devices in a temporary ban right now, with the time left (for the admin page). */
  temporary(): { key: string; scope: string; fails: number; retryAfterMs: number }[] {
    const t = this.now();
    const out: { key: string; scope: string; fails: number; retryAfterMs: number }[] = [];
    for (const [id, c] of this.counters) {
      if (c.until <= t) continue;
      const [scope, key] = id.split("|") as [string, string];
      out.push({ key, scope, fails: c.fails, retryAfterMs: c.until - t });
    }
    return out;
  }

  /** The admin blocks a device for good. False when it already was. */
  block(address: string, scope = "admin"): boolean {
    this.refresh();
    const key = deviceKey(address);
    if (this.permanent.has(key)) return false;
    this.ban(key, scope);
    return true;
  }

  /**
   * The admin lets a device back in: lifts a permanent ban, ends any temporary ban and
   * forgets its failures. False when there was nothing to lift.
   */
  unblock(address: string): boolean {
    this.refresh();
    const key = deviceKey(address);
    let changed = this.permanent.delete(key);
    for (const id of [...this.counters.keys()]) {
      if (id.endsWith(`|${key}`)) {
        this.counters.delete(id);
        changed = true;
      }
    }
    if (changed) {
      console.warn(`blocklist: ${key} was unblocked by the admin`);
      void this.save();
    }
    return changed;
  }

  private ban(key: string, scope: string) {
    this.permanent.set(key, { key, since: new Date(this.now()).toISOString(), scope });
    console.warn(`blocklist: ${key} is blocked for good (${this.permanentAfter} wrong ${scope} attempts in a row). Remove it from ${this.file} to let it back in.`);
    void this.save();
  }

  private async save() {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, JSON.stringify({ blocked: [...this.permanent.values()] }, null, 2) + "\n", 0o600);
      this.seen = this.stamp();
    } catch (e) {
      console.error("blocklist: could not save the file:", (e as Error).message);
    }
  }

  private stamp() {
    try {
      const s = statSync(this.file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "";
    }
  }

  /** Pick up a manual edit of the file (an entry removed) without a restart. */
  private refresh() {
    const t = this.now();
    if (t - this.checkedAt < this.recheckMs) return;
    this.checkedAt = t;
    if (this.stamp() !== this.seen) this.reload();
  }

  private reload() {
    this.seen = this.stamp();
    if (!existsSync(this.file)) {
      // A deleted file means everyone is let back in.
      this.permanent.clear();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { blocked?: unknown };
      if (!Array.isArray(parsed.blocked)) throw new Error("expected a \"blocked\" list");
      const next = new Map<string, Entry>();
      for (const e of parsed.blocked as unknown[]) {
        if (typeof e !== "object" || e === null || typeof (e as Entry).key !== "string") continue;
        const { key, since, scope } = e as Partial<Entry>;
        next.set(deviceKey(key), { key: deviceKey(key), since: String(since ?? ""), scope: String(scope ?? "") });
      }
      this.permanent = next;
    } catch (e) {
      // A damaged file must not let blocked devices back in: keep what is already in memory.
      console.error(`blocklist: ${this.file} is unreadable (${(e as Error).message}); keeping the list in memory`);
    }
  }
}
