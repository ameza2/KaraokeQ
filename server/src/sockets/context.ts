import type { Server, Socket } from "socket.io";
import type { ClientToServer, ServerToClient } from "@karaoke/shared";
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
  /** The singer on this socket (undefined for a bare screen connection). */
  singerId(): string | undefined;
  /** Leave the room this socket joined (before joining another one). */
  leave(): void;
  /** The room, only if this singer is host or the screen (hasHostPowers). */
  hostRoom(): Room | undefined;
  /** The room, only if this singer may use playback/queue controls (canControl). */
  controlRoom(): Room | undefined;
}

export function createContext(io: IO, socket: AppSocket, rooms: RoomRegistry): SocketContext {
  const room = () => rooms.get(socket.data.code);
  const singerId = () => socket.data.singerId;
  return {
    io,
    socket,
    rooms,
    room,
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
