import { EventEmitter } from "node:events";
import type { QueueItem } from "@karaoke/shared";
import type { PlaybackOutput } from "./output.ts";

/**
 * Step 4 (not implemented yet): drive the TV's native YouTube app through the
 * YouTube "Lounge" protocol after the host pairs with a "Link with TV code".
 *
 * Plan:
 *  - pair(code)  -> POST youtube.com/api/lounge/pairing/get_screen  -> loungeToken
 *  - open a bind session, send setPlaylist with ONE videoId per song
 *  - long-poll the event stream; treat "ended"/idle as emit("ended", itemId)
 */
export class LoungeOutput extends EventEmitter implements PlaybackOutput {
  readonly kind = "lounge" as const;

  async play(_item: QueueItem): Promise<void> {
    throw new Error("Lounge output is not implemented yet");
  }
  async pause() {}
  async resume() {}
  async seek(_seconds: number) {}
  async stop() {}
  async dispose() {
    this.removeAllListeners();
  }
}
