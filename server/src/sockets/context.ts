import type { Server, Socket } from "socket.io";
import type { ClientToServer, ServerToClient } from "@karaoke/shared";
import { blockMessage, type Blocklist } from "../blocklist.ts";
import { socketAddress } from "../net.ts";
import type { Room, RoomRegistry } from "../rooms/index.ts";

export interface SocketData {
  code?: string;
  singerId?: string;
  isScreen?: boolean;
  ipAddress?: boolean; // screen page opened by raw IP (YouTube blocks many videos there)
  host?: string; // the screen page's hostname
}

export type IO = Server<ClientToServer, ServerToClient, {}, SocketData>;
export type AppSocket = Socket<ClientToServer, ServerToClient, {}, SocketData>;

/**
 * What every socket handler module gets: the socket plus the room it joined, and the
 * server-side permission checks. Permissions are decided here, never on the client.
 */
export interface SocketContext {
  io: IO;
  socket: AppSocket;
  rooms: RoomRegistry;
  /** The room this socket joined, if any. */
  room(): Room | undefined;
  /**
   * The room for a code a client typed. A wrong code counts against the device: five in a row
   * lock it out for five minutes, ten for good. `error` is ready to show.
   */
  roomForCode(code: string): { room: Room } | { error: string };
  /**
   * A device is in one room at a time: close this device's sockets in any other room, so a
   * phone that joins a second room leaves the first. Same room, any number of tabs, is fine.
   */
  closeOtherRooms(code: string): void;
  /** The singer on this socket (undefined for a bare screen connection). */
  singerId(): string | undefined;
  /** Leave the room this socket joined (before joining another one). */
  leave(): void;
  /** The room, only if this singer is host or the screen (hasHostPowers). */
  hostRoom(): Room | undefined;
  /** The room, only if this singer may use playback/queue controls (canControl). */
  controlRoom(): Room | undefined;
}

/** One room per device (network address). KARAOKE_ONE_ROOM_PER_DEVICE=0 turns it off, e.g. to test two rooms on one computer. */
const ONE_ROOM_PER_DEVICE = process.env.KARAOKE_ONE_ROOM_PER_DEVICE !== "0";

export function createContext(io: IO, socket: AppSocket, rooms: RoomRegistry, blocklist: Blocklist): SocketContext {
  const room = () => rooms.get(socket.data.code);
  const singerId = () => socket.data.singerId;
  return {
    io,
    socket,
    rooms,
    room,
    roomForCode: (code) => {
      const address = socketAddress(socket);
      const locked = blocklist.status("code", address);
      if (locked.blocked) return { error: blockMessage(locked) };
      const found = rooms.get(code);
      if (found) return { room: found };
      const after = blocklist.fail("code", address);
      return { error: after.blocked ? blockMessage(after) : "That room doesn't exist (or has expired)." };
    },
    closeOtherRooms: (code) => {
      if (!ONE_ROOM_PER_DEVICE) return;
      const address = socketAddress(socket);
      for (const other of io.sockets.sockets.values()) {
        if (other.id === socket.id || !other.data.code || other.data.code === code || socketAddress(other) !== address) continue;
        other.emit("room:closed", { message: "You joined another room on this device, so this one was closed." });
        other.disconnect(true);
      }
    },
    singerId,
    leave: () => {
      const r = room();
      if (!r) return;
      const me = singerId();
      r.disconnect(socket.id);
      socket.leave(r.channel);
      socket.leave(`screen:${r.code}`);
      if (me) socket.leave(r.singerChannel(me));
      socket.data = {};
      r.broadcast();
    },
    hostRoom: () => {
      const r = room();
      return r?.hasHostPowers(singerId()) ? r : undefined;
    },
    controlRoom: () => {
      const r = room();
      return r?.canControl(singerId()) ? r : undefined;
    },
  };
}
