import { DeviceRegistry } from "./devices.ts";

/**
 * Lockout for devices that keep guessing secrets (admin password, room codes, screen codes).
 *
 * A device is its network address. Failures are counted in a row per scope (so a wrong admin
 * password and a wrong room code are tracked separately) and a success clears the count:
 *  - from the 5th failure in a row the device is banned for 5 minutes (each further failure
 *    after the ban ends starts another 5 minutes);
 *  - at the 10th failure in a row it is banned for good, in every scope.
 *
 * Permanent bans are kept on the device's own record (`devices.ts`, `<data>/devices/<address>.json`).
 * To let a device back in, set its `status` to "ok" there: the change is picked up within a few
 * seconds, no restart needed. Temporary bans and the failure counts are in memory only; the
 * record keeps a history of them.
 */
export interface BlockOptions {
  /** Failures in a row that start a temporary ban. */
  tempAfter?: number;
  /** Failures in a row that ban for good. */
  permanentAfter?: number;
  tempMs?: number;
  /** A run of failures is forgotten after this long without a new one. */
  decayMs?: number;
  /** How often the device files are checked for manual edits. */
  recheckMs?: number;
  now?: () => number;
  /** Share a registry (the server does, so it can record activity on it too). */
  devices?: DeviceRegistry;
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
  last: number;
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
  readonly devices: DeviceRegistry;
  private counters = new Map<string, Counter>();
  private readonly tempAfter: number;
  private readonly permanentAfter: number;
  private readonly tempMs: number;
  private readonly decayMs: number;
  private readonly now: () => number;

  constructor(dataDir: string, opts: BlockOptions = {}) {
    this.tempAfter = opts.tempAfter ?? 5;
    this.permanentAfter = opts.permanentAfter ?? 10;
    this.tempMs = opts.tempMs ?? 5 * 60e3;
    this.decayMs = opts.decayMs ?? 60 * 60e3;
    this.now = opts.now ?? Date.now;
    this.devices = opts.devices ?? new DeviceRegistry(dataDir, { now: this.now, recheckMs: opts.recheckMs });
  }

  /** Is this device locked out of `scope` right now? Check this before looking at the secret. */
  status(scope: string, address: string | undefined): BlockStatus {
    const key = deviceKey(address);
    if (this.devices.isBlocked(key)) return { blocked: true, permanent: true };
    const until = this.counters.get(`${scope}|${key}`)?.until ?? 0;
    const left = until - this.now();
    return left > 0 ? { blocked: true, permanent: false, retryAfterMs: left } : { blocked: false };
  }

  /** Blocked for good (the admin's list), in every scope? */
  isPermanent(address: string | undefined): boolean {
    return this.devices.isBlocked(deviceKey(address));
  }

  /** A wrong guess. Does nothing for a device that is already blocked. */
  fail(scope: string, address: string | undefined): BlockStatus {
    const key = deviceKey(address);
    const before = this.status(scope, address);
    if (before.blocked) return before;

    const id = `${scope}|${key}`;
    const c = this.counters.get(id) ?? { fails: 0, until: 0, last: 0 };
    if (this.now() - c.last > this.decayMs) c.fails = 0; // an old run is forgotten, so a typo last week counts for nothing
    c.fails += 1;
    c.last = this.now();
    this.devices.recordFailure(key, scope);
    this.counters.delete(id); // re-insert so the oldest entries come first
    this.counters.set(id, c);
    if (this.counters.size > MAX_COUNTERS) this.counters.delete(this.counters.keys().next().value as string);

    if (c.fails >= this.permanentAfter) {
      this.counters.delete(id);
      this.ban(key, scope);
    } else if (c.fails >= this.tempAfter) {
      c.until = this.now() + this.tempMs;
      this.devices.recordTimeout(key, scope, c.until);
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
    return this.devices.blocked().map((r) => ({ key: r.address, since: r.blocked?.at ?? "", scope: r.blocked?.scope ?? "" }));
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
  block(address: string, scope = "admin", note?: string): boolean {
    const key = deviceKey(address);
    if (!this.devices.block(key, scope, "admin", note)) return false;
    console.warn(`blocklist: ${key} was blocked by the admin`);
    return true;
  }

  /**
   * The admin lets a device back in: lifts a permanent ban, ends any temporary ban and
   * forgets its failures. False when there was nothing to lift.
   */
  unblock(address: string): boolean {
    const key = deviceKey(address);
    let changed = this.devices.unblock(key);
    for (const id of [...this.counters.keys()]) {
      if (id.endsWith(`|${key}`)) {
        this.counters.delete(id);
        changed = true;
      }
    }
    if (changed) console.warn(`blocklist: ${key} was unblocked by the admin`);
    return changed;
  }

  private ban(key: string, scope: string) {
    this.devices.block(key, scope, "auto");
    console.warn(`blocklist: ${key} is blocked for good (${this.permanentAfter} wrong ${scope} attempts in a row). Set its status to "ok" in ${this.devices.dir} to let it back in.`);
  }
}
