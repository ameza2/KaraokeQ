import type { RoomRegistry } from "../rooms/index.ts";
import { createContext, type IO } from "./context.ts";
import { guardSocket } from "./guard.ts";
import { hostHandlers } from "./hostHandlers.ts";
import { playbackHandlers } from "./playbackHandlers.ts";
import { limitSocketEvents } from "./rateLimit.ts";
import { queueHandlers } from "./queueHandlers.ts";
import { roomHandlers } from "./roomHandlers.ts";
import { screenHandlers } from "./screenHandlers.ts";

export type { IO, SocketData } from "./context.ts";

/**
 * Wire every socket event. To add a feature, add a handler module for its area
 * and list it here; the event contract itself lives in shared/src/index.ts.
 */
export function registerSocketHandlers(io: IO, rooms: RoomRegistry) {
  io.on("connection", (socket) => {
    limitSocketEvents(socket);
    guardSocket(socket);
    const ctx = createContext(io, socket, rooms);
    roomHandlers(ctx);
    queueHandlers(ctx);
    playbackHandlers(ctx);
    hostHandlers(ctx);
    screenHandlers(ctx);
  });
}
