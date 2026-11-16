import { randomUUID } from "node:crypto";
import type { Notice, Progress, QueueItem } from "@karaoke/shared";
import { LoungeOutput, pairCast } from "../playback/lounge.ts";
import { isEmbeddable, videoInfo } from "../search.ts";
import type { Room } from "./room.ts";

/** Which room is casting to which TV (by the TV's screen id): the newest pairing wins. */
const castOwners = new Map<string, Room>();

/**
 * A room's YouTube cast (Lounge protocol): pairing, the TV's events, takeovers by the
 * TV remote, and the hand-back to the browser screen. The room keeps the state
 * (`mode`, `lounge`, `pausePending`); this drives it.
 */
export class RoomCast {
  constructor(private room: Room) {}


  private pairing = false;
  /** Songs may have been queued that only play on YouTube: check them when a screen takes over. */
  private needsEmbedCheck = false;

  /**
   * Pair the YouTube cast and move playback there, from the current position.
   * Returns an error message, or null on success.
   */
  async pairCast(rawCode: string): Promise<{ error: string } | { name: string }> {
    if (this.room.lounge) return { error: "Stop casting first, then pair the new code." };
    if (this.pairing) return { error: "Already pairing, one moment." };
    this.pairing = true;
    try {
      const target = await pairCast(rawCode);
      const lounge = new LoungeOutput(target);
      try {
        await lounge.connect();
      } catch (err) {
        await lounge.dispose();
        throw err;
      }
      // The newest connection wins: another room casting to this TV loses it (and must not
      // stop the video this room is about to start), and any joined screen is replaced.
      const rival = castOwners.get(target.screenId);
      if (rival && rival !== this.room) await rival.useScreen("The YouTube cast moved to another room. Pair again or open a screen.", { leaveTv: true });
      castOwners.set(target.screenId, this.room);
      this.needsEmbedCheck = true;
      this.room.replaceScreens(null, "cast");
      this.room.freezeProgress();
      const startAt = this.room.currentTime();
      this.room.lounge = lounge;
      this.wireLounge(lounge);
      this.room.mode = "lounge";
      if (this.room.nowPlaying) void lounge.play(this.room.nowPlaying, { startAt, paused: this.room.paused });
      void lounge.syncNow(); // picks up a video the TV was already playing
      this.room.say(`YouTube cast paired: "${lounge.name}"`);
      this.room.broadcast();
      return { name: lounge.name };
    } catch (err) {
      this.room.say(`YouTube cast pairing failed: ${(err as Error).message}`);
      return { error: (err as Error).message };
    } finally {
      this.pairing = false;
    }
  }

  private wireLounge(lounge: LoungeOutput) {
    lounge.on("ended", (itemId: string) => {
      if (this.room.nowPlaying?.id === itemId) this.room.advance();
    });
    lounge.on("error", (itemId: string) => {
      const item = this.room.nowPlaying;
      if (!item || item.id !== itemId) return;
      this.room.say(`YouTube cast didn't start "${item.title}" (${item.videoId}), skipping`);
      this.room.notify(item.singerId, { level: "error", message: `"${item.title}" didn't start on YouTube and was skipped.` });
      this.room.advance();
    });
    // the TV reports an external video's position as "external": map it to the room's item
    lounge.on("progress", (p: Progress) => this.room.reportProgress(p.itemId === "external" && this.room.nowPlaying?.external ? { ...p, itemId: this.room.nowPlaying.id } : p));
    // someone used the TV remote: follow it instead of fighting it
    lounge.on("remote-state", (s: "playing" | "paused") => this.syncPaused(s === "paused"));
    lounge.on("settled", () => {
      if (!this.room.pausePending) return;
      this.room.pausePending = false;
      this.room.broadcast();
    });
    // The TV started another video by itself: show it as the current video. Someone chose
    // that on purpose, so the song it replaced is dropped; the queue carries on after it.
    lounge.on("external", (videoId: string) => this.takeOver(videoId));
    lounge.on("external-ended", () => {
      if (this.room.nowPlaying?.external) this.room.advance();
    });
    lounge.on("external-idle", () => {
      // back on the TV's home screen: nothing plays, the queue waits
      if (!this.room.nowPlaying?.external) return;
      this.room.say("Cast left its own video; queue on hold");
      this.room.clearStage();
    });
    // The TV left one of our songs. At the end that's just the end; earlier it was a
    // deliberate change, so the song is dropped and the queue waits.
    lounge.on("idle", (itemId: string) => {
      const item = this.room.nowPlaying;
      if (!item || item.id !== itemId) return;
      const d = this.room.progress?.itemId === item.id ? this.room.progress.duration : 0;
      if (d && this.room.currentTime() >= d - 8) return this.room.advance();
      this.room.say(`Cast left "${item.title}" before the end, dropped; queue on hold`);
      this.room.clearStage();
      this.room.notify(item.singerId, { level: "info", message: `"${item.title}" was stopped on YouTube.` });
      if (this.room.hostId && this.room.hostId !== item.singerId) this.room.notify(this.room.hostId, { level: "info", message: `"${item.title}" was stopped on YouTube. The queue is on hold; press play to carry on.` });
    });
    lounge.on("link", (up: boolean) => {
      // The TV keeps playing when our link drops, so the song and its clock carry on as they were.
      this.room.say(`YouTube cast ${up ? "connected" : "disconnected"}`);
      if (up) void lounge.syncNow();
      this.room.broadcast();
    });
    lounge.on("lost", () => {
      if (this.room.hostId) this.room.notify(this.room.hostId, { level: "error", message: "Lost contact with the YouTube cast. It keeps playing its current video; reconnecting…" });
    });
  }

  /** Nothing on stage (the queue is untouched). */

  private takeOver(videoId: string) {
    if (this.room.nowPlaying?.videoId === videoId && this.room.nowPlaying.external) return;
    const replaced = this.room.nowPlaying && !this.room.nowPlaying.external ? this.room.nowPlaying : null; // dropped: the change was deliberate
    if (replaced) this.room.notify(replaced.singerId, { level: "info", message: `"${replaced.title}" was replaced by another video from the TV remote.` });
    const item: QueueItem = {
      id: randomUUID(),
      videoId,
      title: "Playing on YouTube from TV remote",
      channel: "",
      duration: "",
      thumb: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      singerId: "",
      singerName: "TV remote",
      addedAt: Date.now(),
      external: true,
    };
    this.room.nowPlaying = item;
    this.room.paused = false;
    this.room.progress = null;
    this.room.progressAt = null;
    this.room.say(`Cast started its own video (${videoId})${replaced ? `, replacing "${replaced.title}" (dropped)` : ""}`);
    this.room.broadcast();
    void videoInfo(videoId).then((info) => {
      if (!info || this.room.nowPlaying?.id !== item.id) return;
      item.title = info.title || item.title;
      item.channel = info.channel;
      this.room.broadcast();
    });
  }

  /** The TV's own remote paused/resumed: mirror it without sending a command back. */
  private syncPaused(paused: boolean) {
    if (!this.room.nowPlaying || this.room.paused === paused) return;
    if (paused) this.room.freezeProgress();
    this.room.paused = paused;
    if (!paused && this.room.progress && this.room.playbackLive()) this.room.progressAt = Date.now();
    this.room.broadcast();
  }

  private async dropLounge() {
    const old = this.room.lounge;
    this.room.lounge = null;
    this.room.pausePending = false;
    if (old && castOwners.get(old.screen.screenId) === this.room) castOwners.delete(old.screen.screenId);
    await old?.dispose();
  }

  /**
   * The web player can only play videos the uploader allows to be embedded, but the
   * YouTube cast plays anything. When a screen takes over after casting, take the songs
   * it can't play out of the queue (and off the stage), and tell their singers.
   * Does nothing unless the room has cast since the last check.
   */
  async dropUnembeddable() {
    if (!this.needsEmbedCheck || this.room.mode !== "screen") return;
    this.needsEmbedCheck = false;
    const items = [this.room.nowPlaying, ...this.room.queue].filter((x): x is QueueItem => !!x && !x.external);
    const flags = await Promise.all(items.map((x) => isEmbeddable(x.videoId)));
    const blocked = new Set(items.filter((_, i) => !flags[i]).map((x) => x.id));
    if (blocked.size === 0) return;
    const dropped = items.filter((x) => blocked.has(x.id));
    this.room.queue = this.room.queue.filter((x) => !blocked.has(x.id));
    const lostStage = !!this.room.nowPlaying && blocked.has(this.room.nowPlaying.id);
    for (const x of dropped) this.room.say(`dropped "${x.title}" (${x.videoId}): only plays on YouTube`);
    const bySinger = new Map<string, QueueItem[]>();
    for (const x of dropped) bySinger.set(x.singerId, [...(bySinger.get(x.singerId) ?? []), x]);
    for (const [singerId, list] of bySinger)
      this.room.notify(singerId, {
        level: "error",
        message: list.length === 1 ? `"${list[0].title}" only plays on YouTube, so it was removed.` : `${list.length} of your songs only play on YouTube, so they were removed.`,
      });
    if (lostStage) {
      // dropped, not played: it isn't logged or added to the history
      this.room.nowPlaying = null;
      this.room.start(this.room.queue.shift() ?? null);
    } else this.room.broadcast();
  }

  /** Stop casting and carry on from the same spot on the browser screen. */
  async useScreen(message?: string, opts: { leaveTv?: boolean } = {}) {
    if (!this.room.lounge) return;
    this.room.freezeProgress();
    const startAt = this.room.currentTime();
    const lounge = this.room.lounge;
    // a video the TV started itself can't be moved to the browser screen; leave it on the TV
    if (this.room.nowPlaying?.external) {
      this.room.nowPlaying = null;
      this.room.progress = null;
      this.room.progressAt = null;
    } else if (!opts.leaveTv) void lounge.stop();
    await this.dropLounge();
    this.room.mode = "screen";
    this.room.say(message ? `YouTube cast unpaired: ${message}` : "YouTube cast unpaired");
    const onStage = this.room.nowPlaying;
    if (!opts.leaveTv) await this.dropUnembeddable();
    // (if the song on stage was dropped, the next one has already started from the top)
    if (this.room.nowPlaying && this.room.nowPlaying === onStage) void this.room.screenOutput.play(this.room.nowPlaying, { startAt, paused: this.room.paused });
    if (message && this.room.hostId) this.room.notify(this.room.hostId, { level: "error", message });
    this.room.broadcast();
  }

  async dispose() {
    await this.dropLounge();
  }
}
