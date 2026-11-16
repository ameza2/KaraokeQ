import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import { Server } from "socket.io";
import type { ClientToServer, ServerToClient } from "@karaoke/shared";
import { RoomRegistry } from "./rooms.ts";
import { FilePlayLog, dataDir } from "./playLog.ts";
import { getShareHost, lanIps, startShareHostWatch } from "./net.ts";
import { knownNotEmbeddable, rateLimiter, searchVideos, suggest } from "./search.ts";
import { Logger } from "./logger.ts";
import { SiteSettings } from "./siteSettings.ts";
import { AdminAuth, FileCredentialStore } from "./admin/credentials.ts";
import { adminRouter } from "./admin/routes.ts";
import { Metrics } from "./metrics.ts";

// Capture console output into the log files before anything else logs.
const logger = new Logger(dataDir());
logger.captureConsole();

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
app.set("trust proxy", true);
app.use(express.json());

const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient, {}, SocketData>(http, { cors: { origin: true } });
const playLog = new FilePlayLog(dataDir());
console.log(`data folder: ${dataDir()} (play log, logs, settings, admin login)`);
const rooms = new RoomRegistry(io, playLog);
const siteSettings = new SiteSettings(dataDir());
const credentials = new FileCredentialStore(dataDir());
// Performance history for the admin debug page (one sample a minute, 7 days).
const metrics = new Metrics(dataDir(), () => {
  const live = rooms.list();
  return {
    sockets: io.engine.clientsCount,
    rooms: live.length,
    singers: live.reduce((n, r) => n + [...r.singers.values()].filter((s) => !s.screen && s.sockets.size > 0).length, 0),
  };
});
metrics.start();

interface SocketData {
  code?: string;
  singerId?: string;
  isScreen?: boolean;
  ipAddress?: boolean; // screen page opened by raw IP (YouTube blocks many videos there)
  host?: string; // the screen page's hostname
}

/** Short browser label for logs, e.g. "Chrome 142 / Windows". */
function browserLabel(ua: string) {
  const b = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
    : /SamsungBrowser\/(\d+)/.exec(ua) ? `Samsung Internet ${/SamsungBrowser\/(\d+)/.exec(ua)![1]}`
    : /CriOS\/(\d+)/.exec(ua) ? `Chrome iOS ${/CriOS\/(\d+)/.exec(ua)![1]}`
    : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
    : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
    : /Version\/(\d+).*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
    : "browser?";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Tizen|Web0S|SmartTV/i.test(ua) ? "TV" : /Linux/.test(ua) ? "Linux" : "?";
  return `${b} / ${os}${/HeadlessChrome/.test(ua) ? " (headless)" : ""}`;
}

// ---------- HTTP API ----------

// by: "client" → the creator gets the host token.
// by: "screen" → a screen created it; no token. Either way, a room without a host
// gives host to the first person who joins.
app.post("/api/rooms", (req, res) => {
  const byScreen = req.body?.by === "screen";
  const room = rooms.create();
  res.json(byScreen ? { code: room.code } : { code: room.code, hostToken: room.hostToken });
});

// The room's full play history (every song, oldest first). Singers' list shows the last 30.
app.get("/api/rooms/:code/plays", async (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return void res.status(404).json({ error: "No such room." });
  const plays = await playLog.plays(room.id);
  res.json({ code: room.code, createdAt: room.createdAt, count: plays.length, plays });
});

app.get("/api/rooms/:code", (req, res) => {
  res.json({ exists: !!rooms.get(req.params.code) });
});

const searchLimit = rateLimiter(30, 60e3); // paging counts too
app.get("/api/search", async (req, res) => {
  if (!searchLimit(req.ip ?? "?")) return void res.status(429).json({ error: "Slow down — too many searches." });
  try {
    // Filter by what the room's current output can play (default: web player).
    const room = rooms.get(String(req.query.room ?? ""));
    const playableOnly = (room?.mode ?? "screen") === "screen";
    res.json(await searchVideos(String(req.query.q ?? ""), Number(req.query.limit ?? 25), playableOnly));
  } catch (err) {
    console.error("search failed:", err);
    res.status(502).json({ error: "Search is temporarily unavailable. Try again in a moment." });
  }
});

const suggestLimit = rateLimiter(60, 60e3);
app.get("/api/suggest", async (req, res) => {
  if (!suggestLimit(req.ip ?? "?")) return void res.json({ suggestions: [] });
  try {
    res.json({ suggestions: await suggest(String(req.query.q ?? "")) });
  } catch {
    res.json({ suggestions: [] });
  }
});

// How other devices should reach us: a hostname when one works (see net.ts), else LAN IPs.
startShareHostWatch();
app.get("/api/info", (_req, res) => {
  res.json({ lanIps: lanIps(), shareHost: getShareHost() });
});

// Admin area (sign-in, room reports and management, appearance, debug).
app.use("/api/admin", adminRouter({ io, rooms, playLog, auth: new AdminAuth(credentials), settings: siteSettings, logger, metrics, dataDir: dataDir() }));

app.get("/api/qr", async (req, res) => {
  const url = String(req.query.url ?? "");
  if (!/^https?:\/\//.test(url) || url.length > 300) return void res.status(400).end();
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(svg);
});

// Unknown API paths get JSON, not the web page.
app.use("/api", (_req, res) => void res.status(404).json({ error: "Not found." }));

// Production: serve the built client.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

// ---------- Realtime ----------

io.on("connection", (socket) => {
  const room = () => rooms.get(socket.data.code);

  socket.on("room:join", ({ code, singerId, name, hostToken, asScreen }, ack) => {
    const r = rooms.get(code);
    if (!r) return ack({ ok: false, error: "That room doesn't exist (or has expired)." });
    const cleanName = String(name ?? "").trim().slice(0, 24);
    if (!cleanName || !singerId) return ack({ ok: false, error: "Enter a name to join." });

    const id = String(singerId).slice(0, 64);
    // Host = whoever proves it with the current token, or the first person into a room
    // that has no host yet. A screen device never takes the host spot (it gets host powers instead).
    const screen = !!asScreen;
    const claimed = !screen && hostToken !== r.hostToken && !r.hostId;
    if (!screen && (hostToken === r.hostToken || claimed)) r.hostId = id;
    const isHost = r.isHost(id);

    socket.data = { code: r.code, singerId: id };
    socket.join([r.channel, r.singerChannel(socket.data.singerId!)]);
    if (!r.singers.get(id)?.sockets.size) r.say(`${screen ? "screen device" : "singer"} joined: ${cleanName}${isHost ? " (host)" : ""}`);
    r.upsertSinger(socket.data.singerId!, cleanName, socket.id, screen);
    ack({ ok: true, state: r.state(), isHost, ...(claimed ? { hostToken: r.hostToken } : {}) });
    if (claimed) socket.emit("notice", { level: "info", message: "You're the host of this room." });
    if (r.progress) socket.emit("playback:progress", r.progress);
    r.broadcast();
  });

  socket.on("singer:rename", ({ name }) => {
    const r = room();
    const clean = String(name ?? "").trim().slice(0, 24);
    if (!r || !clean || !socket.data.singerId) return;
    r.upsertSinger(socket.data.singerId, clean, socket.id);
    r.broadcast();
  });

  socket.on("queue:add", ({ video }, ack) => {
    const r = room();
    if (!r || !socket.data.singerId) return ack({ ok: false, error: "Not in a room." });
    if (!video?.videoId || !/^[\w-]{11}$/.test(video.videoId)) return ack({ ok: false, error: "Invalid video." });
    const safe = {
      videoId: video.videoId,
      title: String(video.title ?? "").slice(0, 200),
      channel: String(video.channel ?? "").slice(0, 100),
      duration: String(video.duration ?? "").slice(0, 12),
      thumb: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`,
    };
    if (r.mode === "screen" && knownNotEmbeddable(video.videoId))
      return ack({ ok: false, error: "The uploader blocks this video outside YouTube. Pick another version." });
    const err = r.add(safe, socket.data.singerId);
    ack(err ? { ok: false, error: err } : { ok: true });
  });

  socket.on("queue:remove", ({ itemId }) => {
    const r = room();
    r?.remove(itemId, socket.data.singerId ?? "", r.canControl(socket.data.singerId));
  });

  socket.on("queue:move", ({ itemId, toIndex }) => {
    const r = room();
    if (r?.canControl(socket.data.singerId)) r.move(itemId, Number(toIndex));
  });

  socket.on("playback:skip", () => {
    const r = room();
    if (r?.canSkip(socket.data.singerId ?? "")) r.advance();
  });
  socket.on("playback:rewind", () => {
    const r = room();
    if (r?.canControl(socket.data.singerId)) r.rewind();
  });

  socket.on("history:replay", ({ itemId }, ack) => {
    const r = room();
    if (!r || !socket.data.singerId) return ack({ ok: false, error: "Not in a room." });
    const h = r.history.find((x) => x.id === itemId);
    if (h && r.mode === "screen" && knownNotEmbeddable(h.videoId))
      return ack({ ok: false, error: "The uploader blocks this video outside YouTube." });
    const err = r.replay(String(itemId), socket.data.singerId);
    ack(err ? { ok: false, error: err } : { ok: true });
  });

  // Anyone in the room can pause/resume (e.g. the singer needs a moment).
  socket.on("playback:pause", () => {
    if (socket.data.singerId) room()?.pause();
  });
  socket.on("playback:resume", () => {
    if (socket.data.singerId) room()?.resume();
  });

  // ----- host-only -----
  socket.on("host:transfer", ({ singerId }, ack) => {
    const r = room();
    if (!r || !r.hasHostPowers(socket.data.singerId)) return ack({ ok: false, error: "Only the host can do that." });
    const target = r.singers.get(String(singerId));
    if (!target || target.screen || target.sockets.size === 0) return ack({ ok: false, error: "That person isn't connected right now." });
    // (when the screen moves host away from someone, assignHost tells them who has it now)
    if (!r.assignHost(target.id, socket.data.singerId)) return ack({ ok: false, error: "Couldn't hand over host." });
    ack({ ok: true });
  });

  // ----- any singer -----
  socket.on("host:claim", (ack) => {
    const r = room();
    const id = socket.data.singerId;
    if (!r || !id) return ack({ ok: false, error: "Join the room first." });
    if (!r.claimHost(id)) return ack({ ok: false, error: "The host is connected, or hasn't been away long enough." });
    ack({ ok: true });
  });

  socket.on("settings:update", (patch) => {
    const r = room();
    if (r?.hasHostPowers(socket.data.singerId)) r.updateSettings(patch ?? {});
  });

  socket.on("playback:seek", ({ seconds }) => {
    const r = room();
    if (r?.canControl(socket.data.singerId)) r.seek(Number(seconds));
  });

  socket.on("cast:pair", async ({ code }, ack) => {
    const r = room();
    if (!r || !r.hasHostPowers(socket.data.singerId)) return ack({ ok: false, error: "Only the host can do that." });
    const result = await r.pairCast(String(code ?? ""));
    ack("error" in result ? { ok: false, error: result.error } : { ok: true, name: result.name });
  });
  socket.on("cast:unpair", () => {
    const r = room();
    if (r?.hasHostPowers(socket.data.singerId)) void r.useScreen();
  });

  socket.on("screen:progress", (p) => {
    if (socket.data.isScreen && room()?.mode === "screen") room()?.reportProgress(p);
  });

  socket.on("screen:join", async ({ code, deviceId, host }, ack) => {
    const r = rooms.get(code);
    if (!r) return ack({ ok: false, error: "That room doesn't exist (or has expired)." });
    // One output per room: the newest one wins. A screen joining stops the YouTube cast
    // (the host pairs again to cast), and older screens are told and dropped.
    if (r.mode === "lounge") await r.useScreen("Another screen has taken over. Pair again to cast.");
    await r.dropUnembeddable(); // a room that cast: songs the web player can't play are removed
    r.replaceScreens(socket.id, "screen");

    const h = String(host ?? "");
    // raw IP or localhost: YouTube blocks many videos for pages opened at these
    const rawAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[") || h === "localhost" || h.endsWith(".localhost");
    socket.data = { code: r.code, isScreen: true, ipAddress: rawAddress, host: h || "?" };
    console.log(`[${r.code}] screen joined: ${h || "?"} (${browserLabel(String(socket.handshake.headers["user-agent"] ?? ""))})`);
    socket.join([r.channel, `screen:${r.code}`]);
    r.screens.add(socket.id);
    // the device showing this screen gets the host's permissions (until another screen takes over)
    r.screenSinger = deviceId ? String(deviceId).slice(0, 64) : null;
    ack({ ok: true, state: r.state() });
    // Pick up exactly where playback was (timestamp + paused state).
    if (r.mode === "screen") socket.emit("screen:command", r.resumeCommand());
    r.broadcast();
  });

  socket.on("screen:event", (e) => {
    const r = room();
    if (r && socket.data.isScreen && r.mode === "screen") r.screenOutput.handleEvent(e, {
        socketId: socket.id,
        ipAddress: !!socket.data.ipAddress,
        host: socket.data.host ?? "?",
        browser: browserLabel(String(socket.handshake.headers["user-agent"] ?? "")),
      });
  });

  socket.on("disconnect", () => {
    const r = room();
    if (!r) return;
    r.disconnect(socket.id);
    r.broadcast();
  });
});

http.listen(PORT, () => {
  console.log(`karaoke server listening on http://localhost:${PORT}`);
  void credentials.load().then(
    (saved) => {
      if (!saved) console.warn("admin: no password set yet. Sign in at /admin with Administrator / password; you'll be asked to choose a new one.");
    },
    (e) => console.error("admin:", (e as Error).message),
  );
});

process.on("uncaughtException", (e) => {
  console.error("uncaught exception:", e);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 200).unref(); // let the log line reach the file
});
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
