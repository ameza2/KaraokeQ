import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type { ActiveDevice, DeviceBan, DeviceRecord } from "@karaoke/shared";
import { writeFileAtomic } from "./atomicWrite.ts";

/**
 * What the server remembers about each device, kept for good: one JSON file per device in
 * `<data>/devices/<address>.json`. A device is its network address (a MAC address never reaches
 * a server across a router). Files are only ever added or changed here, never deleted.
 *
 * Whether a device is blocked for good lives in its file (`status`), so editing a file by hand
 * (set `status` to "ok", `blocked` to null) lets it back in within a few seconds, no restart.
 * A file that cannot be read keeps the version in memory.
 *
 * Writes are batched: a changed record is saved within `flushMs`, and blocking or unblocking
 * is saved at once.
 */
export interface DeviceOptions {
  /** How often the folder is checked for manual edits. */
  recheckMs?: number;
  flushMs?: number;
  now?: () => number;
}

/** Lists in a file stop growing here (the oldest entry goes), so one file stays small. */
const CAP = { bans: 200, names: 50, rooms: 100, userAgents: 20 };

export const deviceFileName = (key: string) => `${key.replace(/[^a-z0-9.-]/gi, "_") || "unknown"}.json`;

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : []);

/** Fill in anything missing, so a hand-edited or older file still loads. */
export function parseDevice(raw: unknown): DeviceRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const address = str(r.address).toLowerCase();
  if (!address) return null;
  const blocked = r.status === "blocked";
  const b = typeof r.blocked === "object" && r.blocked !== null ? (r.blocked as Record<string, unknown>) : {};
  const failures: Record<string, number> = {};
  if (typeof r.failures === "object" && r.failures !== null) for (const [k, v] of Object.entries(r.failures)) failures[k] = num(v);
  return {
    address,
    firstSeen: str(r.firstSeen),
    lastSeen: str(r.lastSeen),
    connections: num(r.connections),
    status: blocked ? "blocked" : "ok",
    blocked: blocked ? { at: str(b.at), scope: str(b.scope), by: b.by === "admin" ? "admin" : "auto" } : null,
    note: str(r.note),
    failures,
    lastFailureAt: typeof r.lastFailureAt === "string" ? r.lastFailureAt : null,
    lockouts: parseLockouts(r.lockouts),
    bans: list(r.bans).map((x) => ({
      kind: x.kind === "permanent" ? "permanent" : "temporary",
      scope: str(x.scope),
      by: x.by === "admin" ? "admin" : "auto",
      at: str(x.at),
      until: typeof x.until === "string" ? x.until : null,
      liftedAt: typeof x.liftedAt === "string" ? x.liftedAt : null,
    })),
    names: list(r.names).map((x) => ({ name: str(x.name), singerId: str(x.singerId), lastSeen: str(x.lastSeen) })),
    rooms: list(r.rooms).map((x) => ({
      code: str(x.code),
      role: x.role === "host" || x.role === "screen" ? x.role : "singer",
      joins: num(x.joins),
      firstAt: str(x.firstAt),
      lastSeen: str(x.lastSeen),
    })),
    userAgents: list(r.userAgents).map((x) => ({ agent: str(x.agent), lastSeen: str(x.lastSeen) })),
  };
}

function parseLockouts(raw: unknown): DeviceRecord["lockouts"] {
  const out: DeviceRecord["lockouts"] = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [scope, v] of Object.entries(raw)) {
    if (typeof v !== "object" || v === null) continue;
    const x = v as Record<string, unknown>;
    out[scope] = { fails: num(x.fails), until: typeof x.until === "string" ? x.until : null, last: str(x.last) };
  }
  return out;
}

interface Live {
  key: string;
  since: string;
  name?: string;
  singerId?: string;
  code?: string;
  role?: string;
}

export class DeviceRegistry {
  readonly dir: string;
  private records = new Map<string, DeviceRecord>();
  /** File stamp last read or written, per device. */
  private stamps = new Map<string, string>();
  private dirty = new Set<string>();
  private live = new Map<string, Live>();
  private checkedAt = 0;
  private writing: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private readonly recheckMs: number;
  private readonly now: () => number;

  constructor(dataDir: string, opts: DeviceOptions = {}) {
    this.dir = path.join(dataDir, "devices");
    this.recheckMs = opts.recheckMs ?? 3000;
    this.now = opts.now ?? Date.now;
    this.loadAll();
    this.importOldBlocklist(dataDir);
    const flushMs = opts.flushMs ?? 2000;
    if (flushMs > 0) {
      this.timer = setInterval(() => void this.flush(), flushMs);
      this.timer.unref();
    }
  }

  private iso = () => new Date(this.now()).toISOString();

  // ----- reading -----

  get(address: string): DeviceRecord | undefined {
    this.refresh();
    return this.records.get(address);
  }

  /** Blocked for good? Checked on every request, so it stays cheap. */
  isBlocked(address: string): boolean {
    this.refresh();
    return this.records.get(address)?.status === "blocked";
  }

  blocked(): DeviceRecord[] {
    this.refresh();
    return [...this.records.values()].filter((r) => r.status === "blocked").sort((a, b) => (b.blocked?.at ?? "").localeCompare(a.blocked?.at ?? ""));
  }

  get size() {
    return this.records.size;
  }

  /** Most recently seen first. `q` matches an address, name, room code or note. */
  recent(limit: number, q = ""): DeviceRecord[] {
    this.refresh();
    const needle = q.trim().toLowerCase();
    const match = (r: DeviceRecord) =>
      !needle ||
      r.address.includes(needle) ||
      r.note.toLowerCase().includes(needle) ||
      r.names.some((n) => n.name.toLowerCase().includes(needle)) ||
      r.rooms.some((x) => x.code.toLowerCase() === needle);
    return [...this.records.values()]
      .filter(match)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, limit);
  }

  /** Devices with an open connection now, one entry per address. */
  active(): ActiveDevice[] {
    const byDevice = new Map<string, ActiveDevice>();
    for (const l of this.live.values()) {
      const d = byDevice.get(l.key) ?? { address: l.key, connections: 0, connectedSince: l.since, people: [] };
      d.connections += 1;
      if (l.since < d.connectedSince) d.connectedSince = l.since;
      if (l.name || l.role) d.people.push({ name: l.name ?? (l.role === "screen" ? "Screen" : ""), room: l.code ?? null, role: l.role ?? null });
      byDevice.set(l.key, d);
    }
    return [...byDevice.values()].sort((a, b) => b.connectedSince.localeCompare(a.connectedSince));
  }

  // ----- activity -----

  connect(socketId: string, address: string, userAgent: string) {
    const r = this.ensure(address);
    r.connections += 1;
    r.lastSeen = this.iso();
    const agent = userAgent.slice(0, 200);
    if (agent) this.upsert(r.userAgents, (u) => u.agent === agent, () => ({ agent, lastSeen: r.lastSeen }), CAP.userAgents, (u) => (u.lastSeen = r.lastSeen));
    this.live.set(socketId, { key: address, since: r.lastSeen });
    this.touch(address);
  }

  /** A socket joined a room (as a singer, host or screen). */
  join(socketId: string, who: { name: string; singerId: string; code: string; role: "singer" | "host" | "screen" }) {
    const l = this.live.get(socketId);
    if (!l) return;
    const r = this.ensure(l.key);
    const at = this.iso();
    r.lastSeen = at;
    if (who.name) this.upsert(r.names, (n) => n.singerId === who.singerId && n.name === who.name, () => ({ name: who.name, singerId: who.singerId, lastSeen: at }), CAP.names, (n) => (n.lastSeen = at));
    this.upsert(
      r.rooms,
      (x) => x.code === who.code && x.role === who.role,
      () => ({ code: who.code, role: who.role, joins: 1, firstAt: at, lastSeen: at }),
      CAP.rooms,
      (x) => {
        x.joins += 1;
        x.lastSeen = at;
      },
    );
    Object.assign(l, { name: who.name, singerId: who.singerId, code: who.code, role: who.role });
    this.touch(l.key);
  }

  disconnect(socketId: string) {
    const l = this.live.get(socketId);
    if (!l) return;
    this.live.delete(socketId);
    const r = this.records.get(l.key);
    if (!r) return;
    r.lastSeen = this.iso();
    this.touch(l.key);
  }

  /** A wrong guess of `scope`. */
  recordFailure(address: string, scope: string) {
    const r = this.ensure(address);
    r.failures[scope] = (r.failures[scope] ?? 0) + 1;
    r.lastFailureAt = r.lastSeen = this.iso();
    this.touch(address);
  }

  /** A timeout that just started. */
  recordTimeout(address: string, scope: string, untilMs: number) {
    const r = this.ensure(address);
    this.push(r.bans, { kind: "temporary", scope, by: "auto", at: this.iso(), until: new Date(untilMs).toISOString(), liftedAt: null }, CAP.bans);
    this.touch(address);
  }

  // ----- timeouts -----

  /** The run of wrong guesses for `scope`, as times in ms. */
  lockout(address: string, scope: string): { fails: number; until: number; last: number } | undefined {
    const l = this.get(address)?.lockouts[scope];
    if (!l) return undefined;
    return { fails: l.fails, until: l.until ? Date.parse(l.until) || 0 : 0, last: Date.parse(l.last) || 0 };
  }

  /** Save the run (or forget it with `undefined`). A timeout that starts is saved at once. */
  setLockout(address: string, scope: string, run: { fails: number; until: number; last: number } | undefined) {
    if (!run) {
      if (!this.records.get(address)?.lockouts[scope]) return;
      delete this.records.get(address)!.lockouts[scope];
      this.touch(address);
      return;
    }
    const r = this.ensure(address);
    r.lockouts[scope] = { fails: run.fails, until: run.until ? new Date(run.until).toISOString() : null, last: new Date(run.last).toISOString() };
    this.touch(address, run.until > 0);
  }

  /** Timeouts running now, for the admin page. */
  timeouts(nowMs: number): { address: string; scope: string; fails: number; retryAfterMs: number }[] {
    this.refresh();
    const out: { address: string; scope: string; fails: number; retryAfterMs: number }[] = [];
    for (const r of this.records.values()) {
      for (const [scope, l] of Object.entries(r.lockouts)) {
        const until = l.until ? Date.parse(l.until) || 0 : 0;
        if (until > nowMs) out.push({ address: r.address, scope, fails: l.fails, retryAfterMs: until - nowMs });
      }
    }
    return out;
  }

  // ----- blocking -----

  /** Block for good. False when it already was. */
  block(address: string, scope: string, by: "auto" | "admin", note?: string): boolean {
    this.refresh();
    const r = this.ensure(address);
    if (r.status === "blocked") return false;
    const at = this.iso();
    r.status = "blocked";
    r.blocked = { at, scope, by };
    if (note) r.note = note.slice(0, 200);
    this.push(r.bans, { kind: "permanent", scope, by, at, until: null, liftedAt: null }, CAP.bans);
    this.touch(address, true);
    return true;
  }

  /** Let a device back in: lifts a block for good and ends any timeout. False when there was nothing to lift. */
  unblock(address: string): boolean {
    this.refresh();
    const r = this.records.get(address);
    if (!r) return false;
    const at = this.iso();
    let changed = false;
    if (Object.keys(r.lockouts).length > 0) {
      r.lockouts = {};
      changed = true;
    }
    if (r.status === "blocked") {
      r.status = "ok";
      r.blocked = null;
      changed = true;
    }
    for (const b of r.bans) {
      if (b.liftedAt || (b.kind === "temporary" && (b.until ?? "") <= at)) continue;
      b.liftedAt = at;
      changed = true;
    }
    if (changed) this.touch(address, true);
    return changed;
  }

  setNote(address: string, note: string): boolean {
    const r = this.records.get(address);
    if (!r) return false;
    r.note = note.slice(0, 200);
    this.touch(address);
    return true;
  }

  // ----- saving -----

  /** Write every changed record now (also used by tests and at shutdown). */
  flush(): Promise<void> {
    // one after another, so a call that finds nothing left to write still waits for the writes already running
    this.writing = this.writing.then(() => this.writeDirty());
    return this.writing;
  }

  private async writeDirty() {
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const r = this.records.get(key);
      if (!r) continue;
      const file = path.join(this.dir, deviceFileName(key));
      try {
        mkdirSync(this.dir, { recursive: true });
        await writeFileAtomic(file, JSON.stringify(r, null, 2) + "\n", 0o600);
        if (!this.dirty.has(key)) this.stamps.set(key, this.stamp(file));
      } catch (e) {
        this.dirty.add(key);
        console.error(`devices: could not save ${file}:`, (e as Error).message);
      }
    }
  }

  private touch(address: string, now = false) {
    this.dirty.add(address);
    if (now) void this.flush();
  }

  private ensure(address: string): DeviceRecord {
    let r = this.records.get(address);
    if (!r) {
      const at = this.iso();
      r = { address, firstSeen: at, lastSeen: at, connections: 0, status: "ok", blocked: null, note: "", failures: {}, lastFailureAt: null, lockouts: {}, bans: [], names: [], rooms: [], userAgents: [] };
      this.records.set(address, r);
    }
    return r;
  }

  private push<T>(items: T[], item: T, cap: number) {
    items.push(item);
    if (items.length > cap) items.shift();
  }

  private upsert<T>(items: T[], is: (x: T) => boolean, make: () => T, cap: number, update: (x: T) => void) {
    const found = items.find(is);
    if (found) update(found);
    else this.push(items, make(), cap);
  }

  // ----- the folder -----

  private stamp(file: string) {
    try {
      const s = statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "";
    }
  }

  private read(file: string): DeviceRecord | null {
    try {
      return parseDevice(JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      console.error(`devices: ${file} is unreadable (${(e as Error).message}); keeping what is in memory`);
      return null;
    }
  }

  private loadAll() {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const file = path.join(this.dir, name);
      const r = this.read(file);
      if (!r) continue;
      this.records.set(r.address, r);
      this.stamps.set(r.address, this.stamp(file));
    }
  }

  /** Pick up hand edits: a changed file is reloaded, a new file is added, a deleted file is forgotten. */
  private refresh() {
    const t = this.now();
    if (t - this.checkedAt < this.recheckMs) return;
    this.checkedAt = t;
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    const present = new Set<string>();
    const keyOfFile = new Map([...this.stamps.keys()].map((k) => [deviceFileName(k), k]));
    for (const name of names) {
      const file = path.join(this.dir, name);
      const stamp = this.stamp(file);
      const key = keyOfFile.get(name);
      if (key) {
        present.add(key);
        if (this.dirty.has(key) || this.stamps.get(key) === stamp) continue;
        this.stamps.set(key, stamp);
        const r = this.read(file);
        if (r && r.address === key) this.records.set(key, r);
        continue;
      }
      const r = this.read(file);
      if (!r || this.records.has(r.address)) continue;
      this.records.set(r.address, r);
      this.stamps.set(r.address, stamp);
      present.add(r.address);
    }
    for (const key of [...this.stamps.keys()]) {
      if (present.has(key) || this.dirty.has(key)) continue;
      this.stamps.delete(key); // the file was deleted by hand: forget the device
      this.records.delete(key);
    }
  }

  /** The earlier `blocklist.json` becomes device files, once. */
  private importOldBlocklist(dataDir: string) {
    const file = path.join(dataDir, "blocklist.json");
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { blocked?: unknown };
      if (!Array.isArray(parsed.blocked)) throw new Error('expected a "blocked" list');
      for (const e of list(parsed.blocked)) {
        const key = str(e.key).toLowerCase();
        if (!key) continue;
        const r = this.ensure(key);
        if (r.status === "blocked") continue;
        const at = str(e.since) || this.iso();
        const scope = str(e.scope) || "login";
        r.status = "blocked";
        r.blocked = { at, scope, by: "auto" };
        const ban: DeviceBan = { kind: "permanent", scope, by: "auto", at, until: null, liftedAt: null };
        r.bans.push(ban);
        this.dirty.add(key);
      }
      renameSync(file, `${file}.migrated`);
      void this.flush();
      console.log(`devices: moved ${file} into ${this.dir} (old file kept as blocklist.json.migrated)`);
    } catch (e) {
      console.error(`devices: could not import ${file} (${(e as Error).message}); it is left alone`);
    }
  }
}
