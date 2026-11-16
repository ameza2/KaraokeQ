/**
 * Runtime shape checks for every client → server payload, one per event in `ClientToServer`
 * (shared/src/index.ts). The guard runs them before a handler sees the packet, so the handlers
 * can rely on the contract's types. Events without a payload (skip, pause, ...) have no entry.
 * Optional fields may be absent but, when present, must have the right type.
 */
type Obj = Record<string, unknown>;

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || ok(v);

const SCREEN_EVENTS = new Set(["ended", "error", "playing", "paused", "skip-blocked"]);

export const PAYLOAD_CHECKS: Record<string, (p: Obj) => boolean> = {
  "room:join": (p) =>
    str(p.code, 16) && str(p.singerId, 200) && str(p.name, 200) && optional(p.hostToken, (x) => str(x, 200)) && optional(p.asScreen, (x) => typeof x === "boolean"),
  "singer:rename": (p) => str(p.name, 200),
  "queue:add": (p) => {
    const v = p.video;
    if (typeof v !== "object" || v === null) return false;
    const video = v as Obj;
    return str(video.videoId, 32) && ["title", "channel", "duration", "thumb"].every((k) => optional(video[k], (x) => str(x, 1000)));
  },
  "queue:remove": (p) => str(p.itemId, 100),
  "queue:move": (p) => str(p.itemId, 100) && num(p.toIndex),
  "history:replay": (p) => str(p.itemId, 100),
  "playback:seek": (p) => num(p.seconds),
  "host:transfer": (p) => str(p.singerId, 200),
  "settings:update": (p) =>
    optional(p.openControls, (x) => typeof x === "boolean") && optional(p.fairQueue, (x) => typeof x === "boolean") && optional(p.theme, (x) => str(x, 40)),
  "cast:pair": (p) => str(p.code, 64),
  "screen:progress": (p) => str(p.itemId, 100) && num(p.time) && num(p.duration),
  "screen:join": (p) => str(p.code, 16) && optional(p.deviceId, (x) => str(x, 200)) && optional(p.host, (x) => str(x, 300)),
  "screen:event": (p) =>
    typeof p.type === "string" && SCREEN_EVENTS.has(p.type) && str(p.itemId, 100) && optional(p.errorCode, num) && optional(p.played, (x) => typeof x === "boolean"),
};
