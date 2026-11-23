import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import type { ClientToServer, Notice, OutputMode, Progress, QueueItem, ReplacedBy, RoomSettings, ScreenCommand, RoomState, ServerToClient, VideoResult } from "@karaoke/shared";
import type { PlaybackOutput } from "../playback/output.ts";
import { ScreenOutput } from "../playback/screen.ts";
import type { LoungeOutput } from "../playback/lounge.ts";
import { toPlayRecord, type PlayLog } from "../playLog.ts";
import { THEMES } from "@karaoke/shared";

type IO = Server<ClientToServer, ServerToClient>;

const MAX_QUEUED_PER_SINGER = 5;
const HISTORY_LIMIT = 30; // shown to singers; the full record is in the play log

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
  /** Screen-created rooms have no host yet: the first phone to join claims it. */
  /** Device id of the active screen (see hasHostPowers). */
  screenSinger: string | null = null;

  /** Most people one room accepts (a person's devices count once). */
  static readonly MAX_SINGERS = 100;
  /** How long the host must be fully disconnected before anyone may claim host. */
  static readonly HOST_AWAY_MS = Number(process.env.KARAOKE_HOST_AWAY_MS) || 5 * 60_000;
  private hostAwaySince: number | null = null;
  private hostAwayTimer: NodeJS.Timeout | null = null;

  /** Track whether the host has any connected device; call after any connect, disconnect or host change. */
  private watchHost() {
    if (this.hostAwayTimer) clearTimeout(this.hostAwayTimer);
    this.hostAwayTimer = null;
    if (!this.hostId || (this.singers.get(this.hostId)?.sockets.size ?? 0) > 0) {
      this.hostAwaySince = null;
      return;
    }
    this.hostAwaySince ??= Date.now();
    const wait = this.hostAwaySince + Room.HOST_AWAY_MS - Date.now();
    if (wait > 0) {
      // tell everyone when the host becomes claimable
      this.hostAwayTimer = setTimeout(() => this.broadcast(), wait + 50);
      this.hostAwayTimer.unref();
    }
  }

  get hostClaimable() {
    return this.hostAwaySince !== null && Date.now() - this.hostAwaySince >= Room.HOST_AWAY_MS;
  }

  /** A singer takes host because the host has been away for 5 minutes or more. */
  claimHost(singerId: string): boolean {
    const me = this.singers.get(singerId);
    if (!me || me.screen || me.sockets.size === 0 || singerId === this.hostId || !this.hostClaimable) return false;
    this.say(`host claimed by ${me.name}: the host was away for ${Math.round((Date.now() - (this.hostAwaySince ?? Date.now())) / 60_000)} min`);
    return this.assignHost(singerId, singerId);
  }

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
    this.hostAwaySince = null;
    this.watchHost();
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
  /** Bumped whenever `history` changes (see RoomState.historyRev). */
  historyRev = 0;
  singers = new Map<string, SingerRecord>();
  screens = new Set<string>();
  lastActive = Date.now();
  /** The browser screen output; always present (idle while a YouTube cast is the output). */
  readonly screenOutput: ScreenOutput;
  /** The YouTube cast (the TV's YouTube app), when one is paired. */
  lounge: LoungeOutput | null = null;

  /** What the room drives right now: the YouTube cast while casting, else the browser screen. */
  get output(): PlaybackOutput {
    return this.mode === "lounge" && this.lounge ? this.lounge : this.screenOutput;
  }

  /** Something is actually playing the videos (a connected screen, or the TV's app). */
  playbackLive() {
    // A TV keeps playing when our link to it drops, so its clock keeps running too.
    return this.mode === "lounge" ? !!this.lounge : this.screens.size > 0;
  }

  /** Unique per room instance (codes get reused after a room expires). */
  readonly id = randomUUID();
  readonly createdAt = Date.now();

  constructor(
    private io: IO,
    readonly code: string,
    private log: PlayLog,
  ) {
    this.screenOutput = this.attach(new ScreenOutput(io, code));
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

  private attach<T extends PlaybackOutput>(output: T): T {
    output.on("ended", (itemId: string) => {
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
      pausePending: this.pausePending,
      queue: this.queue,
      singers: [...this.singers.values()].map((s) => ({ id: s.id, name: s.name, online: s.sockets.size > 0, ...(s.screen ? { screen: true } : {}) })),
      screens: this.screens.size,
      historyCount: this.history.length,
      historyRev: this.historyRev,
      canGoBack: this.canGoBack(),
      hostId: this.hostId,
      screenId: this.screens.size > 0 ? this.screenSinger : null,
      settings: this.settings,
      hostClaimable: this.hostClaimable,
      cast: this.lounge ? { name: this.lounge.name, connected: this.lounge.connected } : null,
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
    this.watchHost();
    // keep display names on queued items in sync
    for (const item of this.queue) if (item.singerId === id) item.singerName = name;
    if (this.nowPlaying?.singerId === id) this.nowPlaying.singerName = name;
  }

  /**
   * One output per room: tell every joined screen (except `except`) that it was replaced
   * and drop it. `by` says what took over, for the message the old screen shows.
   */
  replaceScreens(except: string | null, by: ReplacedBy) {
    for (const id of [...this.screens]) {
      if (id === except) continue;
      const old = this.io.sockets.sockets.get(id);
      old?.emit("screen:replaced", by);
      old?.leave(`screen:${this.code}`); // stop it receiving commands right away
      old?.disconnect(); // the client also hangs up on "screen:replaced" and won't rejoin
      this.disconnect(id); // freezes the playback clock at the old screen's position
    }
  }

  disconnect(socketId: string) {
    // Screen gone: nothing is playing any more, so stop the clock where it was.
    if (this.screens.delete(socketId) && this.screens.size === 0) {
      if (this.mode === "screen") this.freezeProgress();
      this.screenSinger = null;
    }
    for (const s of this.singers.values()) s.sockets.delete(socketId);
    this.watchHost();
  }

  /**
   * Fair (round-robin) insert when `settings.fairQueue` is on: a singer's Nth queued
   * song goes after every other singer's Nth song, so nobody can stack the queue.
   * Off: every request goes to the back (first come, first served).
   */
  add(video: Omit<VideoResult, "thumb">, singerId: string, opts: { toBack?: boolean } = {}): string | null {
    const singer = this.singers.get(singerId);
    if (!singer) return "Join the room first.";
    const mine = this.queue.filter((q) => q.singerId === singerId);
    if (mine.length >= MAX_QUEUED_PER_SINGER) return `You already have ${MAX_QUEUED_PER_SINGER} songs queued.`;
    if (this.queue.some((q) => q.videoId === video.videoId)) return "That song is already in the queue.";

    const { videoId, title, channel, duration } = video; // only these go to the room: no thumb, no extras
    const item: QueueItem = { videoId, title, channel, duration, id: randomUUID(), singerId, singerName: singer.name, addedAt: Date.now() };
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
    const { videoId, title, channel, duration } = h;
    return this.add({ videoId, title, channel, duration }, singerId, { toBack: true });
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
    if (this.nowPlaying && !this.nowPlaying.external) this.queue.unshift(this.nowPlaying);
    this.history = this.history.filter((h) => h.id !== prev.id);
    this.historyRev++;
    this.start(prev);
    return true;
  }

  advance() {
    if (this.nowPlaying && !this.nowPlaying.external) {
      const playedAt = Date.now();
      this.log.record(toPlayRecord(this.id, this.code, this.nowPlaying, playedAt)); // every song, forever
      this.playCount++;
      this.history.unshift({ ...this.nowPlaying, playedAt });
      this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
      this.historyRev++;
      this.previous = this.nowPlaying;
    }
    this.start(this.queue.shift() ?? null);
  }

  start(next: QueueItem | null) {
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
  progressAt: number | null = null;

  /**
   * A seek the browser screen has been told about: until it reports a position near the target,
   * its older reports (already on the wire) would pull the bar back. The cast has its own guard.
   */
  private seekGuard: { itemId: string; target: number; at: number } | null = null;
  private static readonly SEEK_GUARD_MS = 3000;

  /** `measured`: the position was reported by an output, not guessed by us (a seek's optimistic update). */
  reportProgress(p: Progress, measured = true) {
    if (!this.nowPlaying || p.itemId !== this.nowPlaying.id) return;
    const time = Number(p.time), duration = Number(p.duration);
    if (!isFinite(time) || !isFinite(duration)) return;
    if (measured && this.staleAfterSeek(p.itemId, time)) return;
    this.progress = { itemId: p.itemId, time, duration };
    this.progressAt = this.paused || !this.playbackLive() ? null : Date.now();
    this.io.to(this.channel).emit("playback:progress", this.progress);
  }

  /** True when a screen report is from before the last seek took effect (and so is ignored). */
  private staleAfterSeek(itemId: string, time: number): boolean {
    const g = this.seekGuard;
    if (!g) return false;
    const elapsed = (Date.now() - g.at) / 1000;
    if (g.itemId !== itemId || this.mode !== "screen" || elapsed * 1000 > Room.SEEK_GUARD_MS) {
      this.seekGuard = null;
      return false;
    }
    // near the target, or near where playing on from it would be by now (a paused video stays put)
    if (Math.min(Math.abs(time - g.target), Math.abs(time - (g.target + elapsed))) <= 4) {
      this.seekGuard = null;
      return false;
    }
    return true;
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
    this.seekGuard = this.mode === "screen" ? { itemId: this.nowPlaying.id, target: t, at: Date.now() } : null;
    // optimistic update so every phone's bar jumps immediately (a guess, not proof the song plays)
    this.reportProgress({ itemId: this.nowPlaying.id, time: t, duration }, false);
  }

  /** The cast is still applying the last pause/resume; further toggles wait for the TV. */
  pausePending = false;
  private castToggle() {
    if (this.mode === "lounge") this.pausePending = true;
  }

  pause() {
    if (!this.nowPlaying || this.paused || this.pausePending) return;
    this.freezeProgress();
    this.paused = true;
    this.castToggle();
    void this.output.pause();
    this.broadcast();
  }

  resume() {
    // Nothing on stage but songs waiting (the TV went back to its home screen): start the queue.
    if (!this.nowPlaying && this.queue.length) return this.advance();
    if (!this.nowPlaying || !this.paused || this.pausePending) return;
    this.paused = false;
    if (this.progress && this.playbackLive()) this.progressAt = Date.now();
    this.castToggle();
    void this.output.resume();
    this.broadcast();
  }

  /** Nothing on stage (the queue is untouched). */
  clearStage() {
    this.nowPlaying = null;
    this.paused = false;
    this.progress = null;
    this.progressAt = null;
    this.broadcast();
  }

  async dispose() {
    if (this.hostAwayTimer) clearTimeout(this.hostAwayTimer);
    this.log.closeRoom(this.id);
    await this.screenOutput.dispose();
  }
}
