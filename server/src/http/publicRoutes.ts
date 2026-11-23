import type { Express } from "express";
import type { ApiError, CreateRoomResponse, RoomExistsResponse, SearchPage, ServerInfo, SuggestResponse } from "@karaoke/shared";
import QRCode from "qrcode";
import type { RoomRegistry } from "../rooms/index.ts";
import type { PlayLog } from "../playLog.ts";
import { getShareHost, lanIps } from "../net.ts";
import { SearchBusyError, rateLimiter, searchVideos, suggest } from "../search.ts";

/** The public (no sign-in) HTTP API: rooms, search, QR codes and network info. */
export function publicRoutes(app: Express, { rooms, playLog }: { rooms: RoomRegistry; playLog: PlayLog }) {
  // by: "client" → the creator gets the host token.
  // by: "screen" → a screen created it; no token. Either way, a room without a host
  // gives host to the first person who joins.
  const createLimit = rateLimiter(Number(process.env.KARAOKE_ROOM_CREATE_PER_MIN) || 20, 60e3); // rooms per minute per address
  app.post("/api/rooms", (req, res) => {
    if (!createLimit(req.ip ?? "?")) return void res.status(429).json({ error: "Too many rooms created, wait a minute." } satisfies ApiError);
    const byScreen = req.body?.by === "screen";
    const room = rooms.create();
    if (!room) return void res.status(503).json({ error: "This server has too many rooms open right now." } satisfies ApiError);
    res.json((byScreen ? { code: room.code } : { code: room.code, hostToken: room.hostToken }) satisfies CreateRoomResponse);
  });

  // The room's full play history (every song, oldest first). Singers' list shows the last 30.
  app.get("/api/rooms/:code/plays", async (req, res) => {
    const room = rooms.get(req.params.code);
    if (!room) return void res.status(404).json({ error: "No such room." });
    const plays = await playLog.plays(room.id);
    res.json({ code: room.code, createdAt: room.createdAt, count: plays.length, plays });
  });

  app.get("/api/rooms/:code", (req, res) => {
    res.json({ exists: !!rooms.get(req.params.code) } satisfies RoomExistsResponse);
  });

  const searchLimit = rateLimiter(30, 60e3); // paging counts too
  app.get("/api/search", async (req, res) => {
    if (!searchLimit(req.ip ?? "?")) return void res.status(429).json({ error: "Slow down — too many searches." } satisfies ApiError);
    try {
      // Filter by what the room's current output can play (default: web player).
      const room = rooms.get(String(req.query.room ?? ""));
      const playableOnly = (room?.mode ?? "screen") === "screen";
      res.json((await searchVideos(String(req.query.q ?? ""), Number(req.query.page ?? 0), Number(req.query.pageSize ?? 25), playableOnly)) satisfies SearchPage);
    } catch (err) {
      if (err instanceof SearchBusyError) return void res.status(503).json({ error: err.message } satisfies ApiError);
      console.error("search failed:", err);
      res.status(502).json({ error: "Search is temporarily unavailable. Try again in a moment." } satisfies ApiError);
    }
  });

  const suggestLimit = rateLimiter(60, 60e3);
  app.get("/api/suggest", async (req, res) => {
    if (!suggestLimit(req.ip ?? "?")) return void res.json({ suggestions: [] } satisfies SuggestResponse);
    try {
      res.json({ suggestions: await suggest(String(req.query.q ?? "")) } satisfies SuggestResponse);
    } catch {
      res.json({ suggestions: [] } satisfies SuggestResponse);
    }
  });

  // How other devices should reach us: a hostname when one works (see net.ts), else LAN IPs.
  app.get("/api/info", (_req, res) => {
    res.json({ lanIps: lanIps(), shareHost: getShareHost() } satisfies ServerInfo);
  });

  app.get("/api/qr", async (req, res) => {
    const url = String(req.query.url ?? "");
    if (!/^https?:\/\//.test(url) || url.length > 300) return void res.status(400).end();
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(svg);
  });
}
