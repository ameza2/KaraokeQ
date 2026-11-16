import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { QueueItem } from "@karaoke/shared";

/**
 * The complete record of every song played in every room. Rooms only keep the
 * last 30 in memory (that's what singers see); this keeps everything, for
 * 30 days after a room's last song.
 *
 * Storage sits behind the PlayLog interface so the file implementation below can
 * be swapped for a database without touching the room code.
 */
export interface PlayRecord {
  roomId: string; // unique per room (codes are reused once a room expires)
  roomCode: string;
  playedAt: number; // ms epoch: when the song left the stage
  itemId: string;
  videoId: string;
  title: string;
  channel: string;
  duration: string;
  singerId: string;
  singerName: string;
  addedAt: number;
}

export interface RoomRecord {
  roomId: string;
  roomCode: string;
  createdAt: number;
}

export const PLAY_LOG_KEEP_DAYS = 30;

export interface PlayLog {
  /** A room was created. */
  openRoom(room: RoomRecord): void;
  /** A song finished (or was skipped) on stage. Fire-and-forget: never throws. */
  record(play: PlayRecord): void;
  /** The room is gone: no more lines will come, so release what is kept in memory for it. */
  closeRoom(roomId: string): void;
  /** Every play in a room, oldest first. */
  plays(roomId: string): Promise<PlayRecord[]>;
}

/**
 * One JSON-lines file per room: `<data>/rooms/<date>_<CODE>_<roomId>.jsonl`.
 * The first line describes the room ({"type":"room",…}), then one
 * {"type":"play",…} line per song. Append-only, so a crash loses at most the
 * line being written, and each line maps 1:1 to a future database row.
 *
 * A room's file is deleted once nothing has been written to it for
 * PLAY_LOG_KEEP_DAYS (checked at startup and once a day).
 */
export class FilePlayLog implements PlayLog {
  private readonly dir: string;
  private files = new Map<string, string>(); // roomId -> file
  private writes = new Map<string, Promise<void>>(); // per-file write chain (keeps lines in order)
  private ready: Promise<void>;

  constructor(
    dataDir: string,
    private keepDays = PLAY_LOG_KEEP_DAYS,
  ) {
    this.dir = path.join(dataDir, "rooms");
    this.ready = mkdir(this.dir, { recursive: true }).then(
      () => {},
      (e) => console.error(`[playlog] can't create ${this.dir}:`, e),
    );
    void this.ready.then(() => this.prune());
    setInterval(() => void this.prune(), 24 * 3600e3).unref();
  }

  /** Delete room files with no new line for longer than the retention period. Returns how many went. */
  async prune(now = Date.now()): Promise<number> {
    const cutoff = now - this.keepDays * 24 * 3600e3;
    let removed = 0;
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(this.dir, name);
      const s = await stat(file).catch(() => null);
      if (s?.isFile() && s.mtimeMs < cutoff) await unlink(file).then(() => removed++, () => {});
    }
    if (removed) console.log(`play log: removed ${removed} room file${removed === 1 ? "" : "s"} older than ${this.keepDays} days`);
    return removed;
  }

  openRoom(room: RoomRecord) {
    const day = new Date(room.createdAt).toISOString().slice(0, 10);
    const file = path.join(this.dir, `${day}_${room.roomCode}_${room.roomId}.jsonl`);
    this.files.set(room.roomId, file);
    this.append(room.roomId, { type: "room", ...room });
  }

  record(play: PlayRecord) {
    this.append(play.roomId, { type: "play", ...play });
  }

  closeRoom(roomId: string) {
    const pending = this.writes.get(roomId);
    const release = () => {
      if (this.writes.get(roomId) !== pending) return; // something was written since: keep it
      this.writes.delete(roomId);
      this.files.delete(roomId); // plays() finds the file by name from now on
    };
    void (pending ?? Promise.resolve()).then(release, release);
  }

  async plays(roomId: string): Promise<PlayRecord[]> {
    await this.flush(roomId);
    const file = this.files.get(roomId) ?? (await this.find(roomId));
    if (!file) return [];
    const text = await readFile(file, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const row = JSON.parse(line);
          if (row.type !== "play") return [];
          const { type: _type, ...play } = row;
          return [play as PlayRecord];
        } catch {
          return []; // a half-written last line after a crash
        }
      });
  }

  /** Wait until everything queued for a room is on disk. */
  flush(roomId: string) {
    return this.writes.get(roomId) ?? Promise.resolve();
  }

  private append(roomId: string, row: object) {
    const file = this.files.get(roomId);
    if (!file) return console.error(`[playlog] unknown room ${roomId}`);
    const line = JSON.stringify(row) + "\n";
    const prev = this.writes.get(roomId) ?? this.ready;
    const next = prev
      .then(() => appendFile(file, line, "utf8"))
      .catch((e) => console.error(`[playlog] write failed for ${file}:`, e));
    this.writes.set(roomId, next);
  }

  private async find(roomId: string) {
    const name = (await readdir(this.dir).catch(() => [] as string[])).find((f) => f.endsWith(`_${roomId}.jsonl`));
    return name ? path.join(this.dir, name) : undefined;
  }
}

/** Where data files live: $KARAOKE_DATA_DIR, or <repo>/data. */
export const dataDir = () => process.env.KARAOKE_DATA_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");

export const toPlayRecord = (roomId: string, roomCode: string, item: QueueItem, playedAt: number): PlayRecord => ({
  roomId,
  roomCode,
  playedAt,
  itemId: item.id,
  videoId: item.videoId,
  title: item.title,
  channel: item.channel,
  duration: item.duration,
  singerId: item.singerId,
  singerName: item.singerName,
  addedAt: item.addedAt,
});
