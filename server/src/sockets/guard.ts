import type { AppSocket } from "./context.ts";
import { PAYLOAD_CHECKS } from "./payloads.ts";

/**
 * Events whose handler answers through an ack callback. Without one the handler would throw
 * on `ack(...)`, so a packet that lacks it is dropped.
 */
const NEEDS_ACK = new Set(["room:join", "queue:add", "history:get", "history:replay", "host:transfer", "host:claim", "cast:pair", "screen:join"]);

const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

const reply = (args: unknown[], error: string) => {
  const ack = args[args.length - 1];
  if (typeof ack === "function") ack({ ok: false, error });
};

/**
 * One bad packet must never take the server (and every room) down. Two layers:
 *  1. a middleware that rejects packets of the wrong shape (every payload is a plain object whose
 *     fields pass the per-event check in payloads.ts, and the events above must carry an ack function);
 *  2. every handler registered afterwards runs inside a try/catch, async ones included, and a
 *     failure is logged and answered with an error ack when the caller is waiting for one.
 * Call this before registering the handler modules.
 */
export function guardSocket(socket: AppSocket) {
  socket.use(([event, ...args], next) => {
    const ack = args[args.length - 1];
    const payload = typeof ack === "function" ? args.slice(0, -1) : args;
    if (NEEDS_ACK.has(event) && typeof ack !== "function") return; // nobody to answer: drop it
    const check = PAYLOAD_CHECKS[event];
    const shapeOk = payload.every(isObject) && (!check || (isObject(payload[0]) && check(payload[0] as Record<string, unknown>)));
    if (!shapeOk) {
      console.warn(`socket ${socket.id} sent a malformed "${event}" packet; dropped`);
      return reply(args, "That request was not understood.");
    }
    next();
  });

  const on = socket.on.bind(socket) as (event: string, handler: (...args: unknown[]) => unknown) => unknown;
  const fail = (event: string, args: unknown[], err: unknown) => {
    console.error(`socket handler "${event}" failed:`, err);
    reply(args, "Something went wrong.");
  };
  (socket as unknown as { on: typeof on }).on = (event, handler) =>
    on(event, (...args: unknown[]) => {
      try {
        const result = handler(...args);
        if (result instanceof Promise) result.catch((err) => fail(event, args, err));
      } catch (err) {
        fail(event, args, err);
      }
    });
}
