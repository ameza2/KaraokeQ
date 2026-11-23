import { EventEmitter } from "node:events";
import type { Server } from "socket.io";
import type { ClientToServer, QueueItem, ScreenCommand, ScreenEvent, ServerToClient } from "@karaoke/shared";
import type { PlayOptions, PlaybackOutput } from "./output.ts";

/**
 * Plays the queue on the browser that has /r/:code/screen open, using the
 * YouTube IFrame Player API. The screen joins the socket.io room `screen:<code>`
 * (one screen per room; a newer screen replaces the old one).
 */
export interface ScreenInfo {
  socketId: string;
  ipAddress: boolean;
  host: string;
  browser: string;
}

export class ScreenOutput extends EventEmitter implements PlaybackOutput {
  readonly kind = "screen" as const;

  constructor(
    private io: Server<ClientToServer, ServerToClient>,
    private code: string,
  ) {
    super();
  }

  get channel() {
    return `screen:${this.code}`;
  }

  private send(cmd: ScreenCommand) {
    this.io.to(this.channel).emit("screen:command", cmd);
  }

  /** Called by the socket layer when the screen reports a player event. */
  handleEvent(e: ScreenEvent, screen: ScreenInfo) {
    if (e.type === "ended") this.emit("ended", e.itemId);
    else if (e.type === "error") this.emit("player-error", e.itemId, e.errorCode, screen, !!e.played);
    else if (e.type === "skip-blocked") this.emit("skip-blocked", e.itemId);
  }

  async play(item: QueueItem, opts: PlayOptions = {}) {
    this.send({ action: "play", item, ...opts });
  }
  async pause() {
    this.send({ action: "pause" });
  }
  async resume() {
    this.send({ action: "resume" });
  }
  async seek(seconds: number) {
    this.send({ action: "seek", seconds });
  }
  async stop() {
    this.send({ action: "stop" });
  }
  async dispose() {
    this.removeAllListeners();
  }
}
