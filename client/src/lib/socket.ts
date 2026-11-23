import { io, type Socket } from "socket.io-client";
import type { ClientToServer, ServerToClient } from "@karaoke/shared";

export type KSocket = Socket<ServerToClient, ClientToServer>;

export function connect(): KSocket {
  return io({ transports: ["websocket", "polling"] });
}
