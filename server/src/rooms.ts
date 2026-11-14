import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import type { ClientToServer, Notice, OutputMode, Progress, QueueItem, RoomSettings, ScreenCommand, RoomState, ServerToClient, VideoResult } from "@karaoke/shared";
import type { PlaybackOutput } from "./playback/output.ts";
import { ScreenOutput } from "./playback/screen.ts";
import { markNotEmbeddable, unmarkNotEmbeddable } from "./search.ts";
import { getShareHost } from "./net.ts";
import type { ScreenInfo } from "./playback/screen.ts";
import { toPlayRecord, type PlayLog } from "./playLog.ts";
import { THEMES } from "@karaoke/shared";

type IO = Server<ClientToServer, ServerToClient>;

const MAX_QUEUED_PER_SINGER = 5;
const HISTORY_LIMIT = 30; // shown to singers; the full record is in the play log
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

interface SingerRecord {
  id: string;
  name: string;
  sockets: Set<string>;
  screen: boolean;
}

export class Room {
  /** Proof of host for reconnects. Rotated on hand-over so the old host's copy stops working. */
  hostToken = randomBytes(16).toString("hex");
  /** The host is a person (singerId), not a socket: every device they use gets host controls. */
  hostId: string | null = null;
  settings: RoomSettings = { openControls: false, fairQueue: true, theme: "orange" };
  /** TV-created rooms have no host yet: the first phone to join claims it. */
  /** Videos that actually played on a screen in this room (so a later block is device-specific). */
  playedOk = new Set<string>();
  /** The most recent embed block (to spot a screen that blocks everything). */
  private lastBlock: { socketId: string; videoId: string } | null = null;
  /** Device id of the active screen (see hasHostPowers). */
  screenSinger: string | null = null;

  isHost(singerId: string | undefined) {
    return !!singerId && singerId === this.hostId;
  }

  /** The host, or the device that is currently the room's screen. */
  hasHostPowers(singerId: string | undefined) {
    return this.isHost(singerId) || (!!singerId && singerId === this.screenSinger && this.screens.size > 0);
  }

  /** Host powers, or anyone when the host has opened up the controls. */
  canControl(singerId: string | undefined) {
    return !!singerId && (this.hasHostPowers(singerId) || this.settings.openControls);
  }

  /** Hand host to another singer. Returns the new token (old host's token is invalidated). */
  transferHost(toSingerId: string): string | null {
    const to = this.singers.get(toSingerId);
    if (!to || to.screen || toSingerId === this.hostId) return null;
    this.hostId = toSingerId;
    this.hostToken = randomBytes(16).toString("hex");
    this.broadcast();
    return this.hostToken;
  }

  updateSettings(patch: Partial<RoomSettings>) {
    if (typeof patch.openControls === "boolean") this.settings.openControls = patch.openControls;
    // only affects songs added from now on; the current queue order is left alone
    if (typeof patch.fairQueue === "boolean") this.settings.fairQueue = patch.fairQueue;
    if ((THEMES as readonly unknown[]).includes(patch.theme)) this.settings.theme = patch.theme!;
    this.say(`settings: everyone-can-control ${this.settings.openControls ? "on" : "off"}, fair-queue ${this.settings.fairQueue ? "on" : "off"}, colour ${this.settings.theme}`);
    this.broadcast();
  }

  mode: OutputMode = "screen";
  queue: QueueItem[] = [];
  nowPlaying: QueueItem | null = null;
  paused = false;
  history: QueueItem[] = [];
  singers = new Map<string, SingerRecord>();
  screens = new Set<string>();
  lastActive = Date.now();
  output: PlaybackOutput;

  /** Unique per room instance (codes get reused after a room expires). */
  readonly id = randomUUID();
  readonly createdAt = Date.now();

  constructor(
    private io: IO,
    readonly code: string,
    private log: PlayLog,
  ) {
    this.output = this.attach(new ScreenOutput(io, code));
    log.openRoom({ roomId: this.id, roomCode: code, createdAt: this.createdAt });
    this.say("room created");
  }

  /** Total songs that have left the stage in this room. */
  playCount = 0;

  /** Room event log line (the logger files these under the room's code). */
  say(message: string) {
    console.log(`[${this.code}] ${message}`);
  }

  /**
   * Make `toSingerId` the host, give them the proof token and tell the people
   * affected. `actorId` is whoever did it (not told about their own action);
   * omit it when the admin does it.
   */
  assignHost(toSingerId: string, actorId?: string, by = "the admin"): boolean {
    const target = this.singers.get(toSingerId);
    const previous = this.hostId;
    const token = this.transferHost(toSingerId);
    if (!target || !token) return false;
    if (previous && previous !== actorId) this.notify(previous, { level: "info", message: `Host moved to ${target.name}.` });
    this.io.to(this.singerChannel(target.id)).emit("host:token", { hostToken: token });
    this.notify(target.id, { level: "info", message: actorId ? "You're now the host." : `You're now the host (set by ${by}).` });
    this.say(`host: ${this.singers.get(previous ?? "")?.name ?? "nobody"} -> ${target.name}${actorId ? "" : ` (by ${by})`}`);
    return true;
  }

  /** Close the room for good: tell everyone, drop their connections, stop playback. */
  async close(message: string) {
    this.say(`room closed: ${message}`);
    this.io.to(this.channel).emit("room:closed", { message });
    this.io.in(this.channel).disconnectSockets(true);
    await this.dispose();
  }

  get channel() {
    return `room:${this.code}`;
  }
  singerChannel(singerId: string) {
    return `singer:${this.code}:${singerId}`;
  }

  private attach(output: PlaybackOutput) {
    output.on("ended", (itemId: string) => {
      if (this.nowPlaying?.id === itemId) this.advance();
    });
    output.on("error", (itemId: string, errorCode?: number, screen?: ScreenInfo) => {
      const item = this.nowPlaying;
      if (!item || item.id !== itemId) return;
      const embedBlocked = errorCode === 101 || errorCode === 150;
      console.warn(
        `[${this.code}] screen error ${errorCode} on ${item.videoId} "${item.title}" — screen ${screen?.host ?? "?"} (${screen?.browser ?? "?"})${screen?.ipAddress ? " [raw IP]" : ""}`,
      );
      // YouTube can deny a video on one device/address and allow it on another.
      // If it's this screen's problem (raw-IP address, or the song already played on
      // another screen), keep the song and its position instead of skipping it.
      const playedElsewhere = this.playedOk.has(item.videoId);
      // Two different songs in a row blocked on the same screen with nothing playing
      // in between: the screen is the problem, not the videos. Stop skipping.
      const last = this.lastBlock;
      const streak = embedBlocked && !!screen && !!last && last.socketId === screen.socketId && last.videoId !== item.videoId;
      if (embedBlocked && screen) this.lastBlock = { socketId: screen.socketId, videoId: item.videoId };
      if (streak && last) unmarkNotEmbeddable(last.videoId);
      if (embedBlocked && screen && (screen.ipAddress || playedElsewhere || streak)) {
        this.freezeProgress();
        const reason = screen.ipAddress ? "ip" : "device";
        const shareHost = getShareHost();
        this.io.to(screen.socketId).emit("screen:blocked", { itemId, shareHost, reason });
        const msg =
          reason === "device"
            ? `YouTube won't play "${item.title}" on the current screen. If another device was playing it, tap "play here instead" there; otherwise skip it on the screen.`
            : shareHost
              ? `YouTube blocks "${item.title}" on the screen because of its address (IP or localhost). Tap "Reopen at ${shareHost}" on the screen; the song continues from where it stopped.`
              : `YouTube blocks "${item.title}" on the screen because of its address (IP or localhost). Open the screen by the computer's name instead, or skip the song there.`;
        for (const id of new Set([item.singerId, this.hostId].filter((x): x is string => !!x))) this.notify(id, { level: "error", message: msg });
        return;
      }
      if (embedBlocked) markNotEmbeddable(item.videoId);
      this.notify(item.singerId, {
        level: "error",
        message: embedBlocked
          ? `"${item.title}" can't be played on the screen (the uploader blocked embedding). Try another version.`
          : `"${item.title}" failed to play and was skipped.`,
      });
      this.advance();
    });
    // The person at an IP-address screen chose to skip the blocked song.
    output.on("skip-blocked", (itemId: string) => {
      if (this.nowPlaying?.id === itemId) this.advance();
    });
    return output;
  }

  touch() {
    this.lastActive = Date.now();
  }

  isConnected() {
    return this.screens.size > 0 || [...this.singers.values()].some((s) => s.sockets.size > 0);
  }

  state(): RoomState {
    return {
      code: this.code,
      mode: this.mode,
      nowPlaying: this.nowPlaying,
      paused: this.paused,
      queue: this.queue,
      singers: [...this.singers.values()].map((s) => ({ id: s.id, name: s.name, online: s.sockets.size > 0, ...(s.screen ? { screen: true } : {}) })),
      screens: this.screens.size,
      history: this.history,
      canGoBack: this.canGoBack(),
      hostId: this.hostId,
      screenId: this.screens.size > 0 ? this.screenSinger : null,
      settings: this.settings,
    };
  }

  broadcast() {
    this.touch();
    this.io.to(this.channel).emit("room:state", this.state());
  }

  notify(singerId: string, notice: Notice) {
    this.io.to(this.singerChannel(singerId)).emit("notice", notice);
  }

  upsertSinger(id: string, name: string, socketId: string, screen = false) {
    const s = this.singers.get(id) ?? { id, name, sockets: new Set<string>(), screen };
    s.name = name;
    s.screen = screen;
    s.sockets.add(socketId);
    this.singers.set(id, s);
    // keep display names on queued items in sync
    for (const item of this.queue) if (item.singerId === id) item.singerName = name;
    if (this.nowPlaying?.singerId === id) this.nowPlaying.singerName = name;
  }

  disconnect(socketId: string) {
    // Screen gone: nothing is playing any more, so stop the clock where it was.
    if (this.screens.delete(socketId) && this.screens.size === 0) {
      this.freezeProgress();
      this.screenSinger = null;
    }
    for (const s of this.singers.values()) s.sockets.delete(socketId);
  }

  /**
   * Fair (round-robin) insert when `settings.fairQueue` is on: a singer's Nth queued
   * song goes after every other singer's Nth song, so nobody can stack the queue.
   * Off: every request goes to the back (first come, first served).
   */
  add(video: VideoResult, singerId: string, opts: { toBack?: boolean } = {}): string | null {
    const singer = this.singers.get(singerId);
    if (!singer) return "Join the room first.";
    const mine = this.queue.filter((q) => q.singerId === singerId);
    if (mine.length >= MAX_QUEUED_PER_SINGER) return `You already have ${MAX_QUEUED_PER_SINGER} songs queued.`;
    if (this.queue.some((q) => q.videoId === video.videoId)) return "That song is already in the queue.";

    const item: QueueItem = { ...video, id: randomUUID(), singerId, singerName: singer.name, addedAt: Date.now() };
    let insertAt = this.queue.length;
    if (!opts.toBack && this.settings.fairQueue) {
      // The singer on stage has already used up their turn this round.
      const onStage = this.nowPlaying?.singerId;
      const myRound = mine.length + (onStage === singerId ? 1 : 0);
      const seen = new Map<string, number>(onStage ? [[onStage, 1]] : []);
      insertAt = 0;
      this.queue.forEach((q, i) => {
        const round = seen.get(q.singerId) ?? 0;
        seen.set(q.singerId, round + 1);
        if (round <= myRound) insertAt = i + 1;
      });
    }
    this.queue.splice(insertAt, 0, item);
    this.say(`queued by ${singer.name}: "${item.title}" (${item.videoId}) at #${insertAt + 1}`);

    if (!this.nowPlaying) this.advance();
    else this.broadcast();
    return null;
  }

  remove(itemId: string, singerId: string, canControl: boolean) {
    const idx = this.queue.findIndex((q) => q.id === itemId);
    if (idx === -1) return;
    if (!canControl && this.queue[idx].singerId !== singerId) return;
    this.queue.splice(idx, 1);
    this.broadcast();
  }

  move(itemId: string, toIndex: number) {
    const idx = this.queue.findIndex((q) => q.id === itemId);
    if (idx === -1) return;
    const [item] = this.queue.splice(idx, 1);
    this.queue.splice(Math.max(0, Math.min(toIndex, this.queue.length)), 0, item);
    this.broadcast();
  }

  /** Replay a song from history as `singerId`, at the very back of the queue. */
  replay(historyItemId: string, singerId: string): string | null {
    const h = this.history.find((x) => x.id === historyItemId);
    if (!h) return "That song is no longer in the history.";
    const { videoId, title, channel, duration, thumb } = h;
    return this.add({ videoId, title, channel, duration, thumb }, singerId, { toBack: true });
  }

  /** Skipping the last song just ends it (nothing plays until more are queued). */
  canSkip(singerId: string) {
    return !!this.nowPlaying && (this.canControl(singerId) || this.nowPlaying.singerId === singerId);
  }

  /** The one song ⏮ can return to; cleared once used, so you can't go back further. */
  private previous: QueueItem | null = null;
  static readonly RESTART_AFTER = 5; // seconds into a song, ⏮ restarts instead of going back

  canGoBack() {
    return !!this.previous;
  }

  /**
   * ⏮: more than RESTART_AFTER seconds in → restart the song. Otherwise go back
   * to the previous song, putting the current one back at the front of the queue.
   * Returns false when there's nothing to do.
   */
  rewind(): boolean {
    if (this.nowPlaying && this.currentTime() >= Room.RESTART_AFTER) {
      this.seek(0);
      if (this.paused) this.resume();
      return true;
    }
    const prev = this.previous;
    if (!prev) return false;
    this.previous = null;
    if (this.nowPlaying) this.queue.unshift(this.nowPlaying);
    this.history = this.history.filter((h) => h.id !== prev.id);
    this.start(prev);
    return true;
  }

  advance() {
    if (this.nowPlaying) {
      const playedAt = Date.now();
      this.log.record(toPlayRecord(this.id, this.code, this.nowPlaying, playedAt)); // every song, forever
      this.playCount++;
      this.history.unshift({ ...this.nowPlaying, playedAt });
      this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
      this.previous = this.nowPlaying;
    }
    this.start(this.queue.shift() ?? null);
  }

  private start(next: QueueItem | null) {
    this.nowPlaying = next;
    this.paused = false;
    this.progress = null;
    this.progressAt = null;
    if (next) {
      this.say(`now playing: "${next.title}" (${next.videoId}) for ${next.singerName}`);
      void this.output.play(next);
      this.notify(next.singerId, { level: "info", message: `🎤 You're on! "${next.title}"` });
      const upNext = this.queue[0];
      if (upNext && upNext.singerId !== next.singerId)
        this.notify(upNext.singerId, { level: "info", message: "You're up next — get ready!" });
    } else {
      void this.output.stop();
    }
    this.broadcast();
  }

  /** Latest position reported by a screen, relayed to phones (not part of RoomState to keep it small). */
  progress: Progress | null = null;

  /**
   * When `progress` was last known to be advancing in real time (Date.now()),
   * or null when the clock is frozen (paused, or no screen is playing it).
   */
  private progressAt: number | null = null;

  reportProgress(p: Progress) {
    if (!this.nowPlaying || p.itemId !== this.nowPlaying.id) return;
    const time = Number(p.time), duration = Number(p.duration);
    if (!isFinite(time) || !isFinite(duration)) return;
    if (time > 1) {
      this.playedOk.add(this.nowPlaying.videoId); // it really played on some screen
      this.lastBlock = null; // a screen is playing fine
    }
    this.progress = { itemId: p.itemId, time, duration };
    this.progressAt = this.paused || this.screens.size === 0 ? null : Date.now();
    this.io.to(this.channel).emit("playback:progress", this.progress);
  }

  /** Best estimate of the current position of the playing song. */
  currentTime(): number {
    const p = this.progress;
    if (!p || p.itemId !== this.nowPlaying?.id) return 0;
    if (this.progressAt === null) return p.time;
    const t = p.time + (Date.now() - this.progressAt) / 1000;
    return p.duration ? Math.min(t, p.duration - 0.5) : t;
  }

  /** Stop the clock at the current estimate (pause, or the screen went away). */
  freezeProgress() {
    if (this.progress) this.progress = { ...this.progress, time: this.currentTime() };
    this.progressAt = null;
  }

  /** What a newly joined screen should do to pick up exactly where playback is. */
  resumeCommand(): ScreenCommand {
    if (!this.nowPlaying) return { action: "stop" };
    return { action: "play", item: this.nowPlaying, startAt: this.currentTime(), paused: this.paused };
  }

  seek(seconds: number) {
    if (!this.nowPlaying || !isFinite(seconds)) return;
    const duration = this.progress?.itemId === this.nowPlaying.id ? this.progress.duration : 0;
    const t = Math.max(0, duration ? Math.min(seconds, duration - 0.5) : seconds);
    void this.output.seek(t);
    // optimistic update so every phone's bar jumps immediately
    this.reportProgress({ itemId: this.nowPlaying.id, time: t, duration });
  }

  pause() {
    if (!this.nowPlaying || this.paused) return;
    this.freezeProgress();
    this.paused = true;
    void this.output.pause();
    this.broadcast();
  }

  resume() {
    if (!this.nowPlaying || !this.paused) return;
    this.paused = false;
    if (this.progress && this.screens.size > 0) this.progressAt = Date.now();
    void this.output.resume();
    this.broadcast();
  }

  async dispose() {
    await this.output.dispose();
  }
}

export class RoomRegistry {
  private rooms = new Map<string, Room>();

  constructor(
    private io: IO,
    readonly log: PlayLog,
  ) {
    // Drop rooms nobody has touched for 6 hours.
    setInterval(() => {
      const cutoff = Date.now() - 6 * 3600e3;
      for (const [code, room] of this.rooms)
        if (!room.isConnected() && room.lastActive < cutoff) {
          room.say("room expired (idle for 6 hours)");
          void room.dispose();
          this.rooms.delete(code);
        }
    }, 10 * 60e3).unref();
  }

  create(): Room {
    let code: string;
    do {
      code = Array.from(randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    } while (this.rooms.has(code));
    const room = new Room(this.io, code, this.log);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string | undefined): Room | undefined {
    return code ? this.rooms.get(code.toUpperCase()) : undefined;
  }

  /** Every live room, oldest first. */
  list(): Room[] {
    return [...this.rooms.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Close and forget a room. Returns false when there's no such room. */
  async delete(code: string, message: string): Promise<boolean> {
    const room = this.get(code);
    if (!room) return false;
    this.rooms.delete(room.code);
    await room.close(message);
    return true;
  }
}
