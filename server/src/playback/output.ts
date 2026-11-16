import { EventEmitter } from "node:events";
import type { QueueItem } from "@karaoke/shared";

export interface PlayOptions {
  /** Start this many seconds in (switching output mid-song). */
  startAt?: number;
  /** Start, then pause. */
  paused?: boolean;
}

/**
 * A playback target the room drives. The room owns the queue; an output only
 * plays one item at a time and reports back when it ends or fails.
 *
 * Events:
 *   "ended"  (itemId: string)
 *   "error"  (itemId: string, errorCode?: number)
 */
export interface PlaybackOutput extends EventEmitter {
  readonly kind: "screen" | "lounge";
  play(item: QueueItem, opts?: PlayOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(seconds: number): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
