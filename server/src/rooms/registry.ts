import { randomBytes } from "node:crypto";
import type { Server } from "socket.io";
import type { ClientToServer, ServerToClient } from "@karaoke/shared";
import type { PlayLog } from "../playLog.ts";
import { CODE_ALPHABET, Room } from "./room.ts";

type IO = Server<ClientToServer, ServerToClient>;

export class RoomRegistry {
  /** Live rooms allowed at once (each one holds memory and a play-log file). */
  static readonly MAX_ROOMS = Number(process.env.KARAOKE_MAX_ROOMS) || 200;
  /** A room nobody is connected to is dropped after this long without activity (checked every 10 minutes). */
  static readonly IDLE_MS = 2 * 3600e3;
  private rooms = new Map<string, Room>();

  constructor(
    private io: IO,
    readonly log: PlayLog,
  ) {
    // Drop rooms nobody is in and nobody has touched for IDLE_MS.
    setInterval(() => {
      const cutoff = Date.now() - RoomRegistry.IDLE_MS;
      for (const [code, room] of this.rooms)
        if (!room.isConnected() && room.lastActive < cutoff) {
          room.say(`room expired (idle for ${RoomRegistry.IDLE_MS / 3600e3} hours)`);
          void room.dispose();
          this.rooms.delete(code);
        }
    }, 10 * 60e3).unref();
  }

  /** A new room, or null when the server already has MAX_ROOMS. */
  create(): Room | null {
    if (this.rooms.size >= RoomRegistry.MAX_ROOMS) return null;
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
