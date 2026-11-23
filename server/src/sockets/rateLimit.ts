import type { AppSocket } from "./context.ts";

const BURST = 60; // events a socket may send at once
const PER_SECOND = 20; // sustained rate after that

/**
 * Per-socket token bucket, so one misbehaving client can't make the server broadcast
 * room state in a loop. Normal use is far below this (a screen reports about once a second,
 * a drag-reorder sends a handful of moves). Events over the limit are dropped, and an event
 * that expects an answer gets an error back so its caller doesn't wait forever.
 */
export function limitSocketEvents(socket: AppSocket) {
  let tokens = BURST;
  let last = Date.now();
  let warned = false;
  socket.use((packet, next) => {
    const now = Date.now();
    tokens = Math.min(BURST, tokens + ((now - last) / 1000) * PER_SECOND);
    last = now;
    if (tokens >= 1) {
      tokens -= 1;
      return next();
    }
    if (!warned) {
      warned = true;
      console.warn(`socket ${socket.id} is sending too fast (${packet[0]}); dropping events`);
    }
    const ack = packet[packet.length - 1];
    if (typeof ack === "function") ack({ ok: false, error: "Slow down, too many requests." });
  });
}
