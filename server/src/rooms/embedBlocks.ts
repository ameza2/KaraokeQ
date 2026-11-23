import type { Server } from "socket.io";
import type { ClientToServer, QueueItem, ServerToClient } from "@karaoke/shared";
import { getShareHost } from "../net.ts";
import { markNotEmbeddable, unmarkNotEmbeddable } from "../search.ts";
import type { ScreenInfo } from "../playback/screen.ts";
import type { Room } from "./room.ts";

/**
 * What to do when the browser screen's player reports an error (101/150 and friends):
 * hold the song when the screen is the problem, skip it when the video is. See
 * CONTEXT.md §6 ("Hard-won gotchas") before changing these rules.
 */
export class EmbedBlockPolicy {
  /** Videos that actually played on a screen in this room (so a later block is device-specific). */
  private playedOk = new Set<string>();
  /** The most recent embed block (to spot a screen that blocks everything). */
  private lastBlock: { socketId: string; videoId: string } | null = null;

  constructor(
    private room: Room,
    private io: Server<ClientToServer, ServerToClient>,
  ) {}

  /** The song really played on a screen: later blocks are about the device, not the video. */
  markPlayed(videoId: string) {
    this.playedOk.add(videoId);
    this.lastBlock = null; // a screen is playing fine
  }

  handleError(itemId: string, errorCode?: number, screen?: ScreenInfo, played?: boolean) {
    const item = this.room.nowPlaying;
    if (!item || item.id !== itemId) return;
    const codeBlocked = errorCode === 101 || errorCode === 150;
    // An embed block fails at load. 101/150 after the video was already playing means YouTube
    // stopped it mid-way, most often because the signed-in account's plan hit its device limit
    // (e.g. the same Premium account is also casting to the TV). That says nothing about the video.
    const interrupted = codeBlocked && !!played && !!screen;
    const embedBlocked = codeBlocked && !interrupted;
    console.warn(
      `[${this.room.code}] screen error ${errorCode} on ${item.videoId} "${item.title}" — screen ${screen?.host ?? "?"} (${screen?.browser ?? "?"})${screen?.ipAddress ? " [raw IP]" : ""}${interrupted ? " [after it started playing]" : ""}`,
    );
    if (interrupted && screen) return this.holdForLimit(item, screen);

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
    if (embedBlocked && screen && (screen.ipAddress || playedElsewhere || streak)) return this.holdForScreen(item, screen, playedElsewhere, streak);

    if (embedBlocked) markNotEmbeddable(item.videoId);
    this.room.notify(item.singerId, {
      level: "error",
      message: embedBlocked
        ? `"${item.title}" only plays on YouTube, so the web player skipped it. Try another version.`
        : `"${item.title}" failed to play and was skipped.`,
    });
    this.room.advance();
  }

  /** YouTube stopped the song while it played (the account's device limit): hold it and say why. */
  private holdForLimit(item: QueueItem, screen: ScreenInfo) {
    this.room.freezeProgress();
    this.io.to(screen.socketId).emit("screen:blocked", { itemId: item.id, shareHost: null, reason: "limit" });
    this.room.say(`holding "${item.title}": YouTube stopped it while playing (likely the account's device limit)`);
    this.tellSingerAndHost(item, `YouTube stopped "${item.title}" while it was playing. If the screen is signed in to the same Google account as the YouTube cast, the plan's device limit may be reached: use the screen signed out or in Incognito, or skip the song.`);
  }

  /** The screen is the problem (raw address, or the song already played elsewhere, or a streak): hold the song. */
  private holdForScreen(item: QueueItem, screen: ScreenInfo, playedElsewhere: boolean, streak: boolean) {
    this.room.freezeProgress();
    const reason = screen.ipAddress ? "ip" : "device";
    const why = screen.ipAddress ? "screen is on a raw address" : playedElsewhere ? "it already played on a screen in this room" : streak ? "two songs in a row were blocked on this screen" : "blocked";
    this.room.say(`holding "${item.title}": ${why}`);
    const shareHost = getShareHost();
    this.io.to(screen.socketId).emit("screen:blocked", { itemId: item.id, shareHost, reason });
    const msg =
      reason === "device"
        ? `YouTube won't play "${item.title}" on the current screen. If another device was playing it, tap "play here instead" there; otherwise skip it on the screen.`
        : shareHost
          ? `YouTube blocks "${item.title}" on the screen because of its address (IP or localhost). Tap "Reopen at ${shareHost}" on the screen; the song continues from where it stopped.`
          : `YouTube blocks "${item.title}" on the screen because of its address (IP or localhost). Open the screen by the computer's name instead, or skip the song there.`;
    this.tellSingerAndHost(item, msg);
  }

  private tellSingerAndHost(item: QueueItem, message: string) {
    for (const id of new Set([item.singerId, this.room.hostId].filter((x): x is string => !!x))) this.room.notify(id, { level: "error", message });
  }
}
