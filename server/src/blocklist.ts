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
 * seconds, no restart needed. A timeout and the run of wrong guesses behind it are in the same
 * record (`lockouts`), so they survive a restart and can be edited: set `until` to a past time,
 * or delete the scope's entry, to end a timeout.
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
    const left = (this.devices.lockout(key, scope)?.until ?? 0) - this.now();
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

    const t = this.now();
    const run = this.devices.lockout(key, scope);
    // an old run is forgotten, so a typo last week counts for nothing
    const fails = (run && t - run.last <= this.decayMs ? run.fails : 0) + 1;
    this.devices.recordFailure(key, scope);

    if (fails >= this.permanentAfter) {
      this.devices.setLockout(key, scope, undefined);
      this.ban(key, scope);
    } else if (fails >= this.tempAfter) {
      const until = t + this.tempMs;
      this.devices.setLockout(key, scope, { fails, until, last: t });
      this.devices.recordTimeout(key, scope, until);
      console.warn(`blocklist: ${key} is blocked for ${Math.round(this.tempMs / 60e3)} min (${fails} wrong ${scope} attempts in a row)`);
    } else {
      this.devices.setLockout(key, scope, { fails, until: 0, last: t });
    }
    return this.status(scope, address);
  }

  /** A correct guess: the run of failures starts over. */
  succeed(scope: string, address: string | undefined) {
    this.devices.setLockout(deviceKey(address), scope, undefined);
  }

  /** Permanently blocked devices, for the admin and tests. */
  list(): Entry[] {
    return this.devices.blocked().map((r) => ({ key: r.address, since: r.blocked?.at ?? "", scope: r.blocked?.scope ?? "" }));
  }

  /** Devices in a temporary ban right now, with the time left (for the admin page). */
  temporary(): { key: string; scope: string; fails: number; retryAfterMs: number }[] {
    return this.devices.timeouts(this.now()).map((t) => ({ key: t.address, scope: t.scope, fails: t.fails, retryAfterMs: t.retryAfterMs }));
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
    const changed = this.devices.unblock(key); // also forgets the runs of wrong guesses and ends timeouts
    if (changed) console.warn(`blocklist: ${key} was unblocked by the admin`);
    return changed;
  }

  private ban(key: string, scope: string) {
    this.devices.block(key, scope, "auto");
    console.warn(`blocklist: ${key} is blocked for good (${this.permanentAfter} wrong ${scope} attempts in a row). Set its status to "ok" in ${this.devices.dir} to let it back in.`);
  }
}
