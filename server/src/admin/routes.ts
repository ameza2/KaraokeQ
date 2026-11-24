import { randomBytes } from "node:crypto";
import os from "node:os";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Server } from "socket.io";
import type { AdminRoomReport, BlocklistReport, AdminSession, AdminStats, MetricHistory } from "@karaoke/shared";
import type { Logger } from "../logger.ts";
import type { PlayLog } from "../playLog.ts";
import type { Room, RoomRegistry } from "../rooms/index.ts";
import { isTheme, type SiteSettings } from "../siteSettings.ts";
import { castLog } from "../playback/lounge.ts";
import { AdminAuth } from "./credentials.ts";
import type { Metrics } from "../metrics.ts";
import { blockMessage, deviceKey, type Blocklist } from "../blocklist.ts";

/**
 * Everything under /api/admin. Every route except login/session/logout needs a
 * valid session cookie, and a session that is still on the default password can
 * only change the password.
 *
 * Sessions live in memory (a restart signs the admin out). The cookie is
 * HttpOnly + SameSite=Strict, so page scripts can't read it and other sites
 * can't use it.
 */
const COOKIE = "karaoke_admin";
const SESSION_MS = 12 * 3600e3;

interface Session {
  username: string;
  mustChangePassword: boolean;
  expires: number;
}

export interface AdminDeps {
  io: Server;
  rooms: RoomRegistry;
  playLog: PlayLog;
  auth: AdminAuth;
  settings: SiteSettings;
  logger: Logger;
  metrics: Metrics;
  blocklist: Blocklist;
  dataDir: string;
}

export function adminRouter({ io, rooms, playLog, auth, settings, logger, metrics, blocklist, dataDir }: AdminDeps): Router {
  const router = Router();
  const sessions = new Map<string, Session>();
  const startedAt = Date.now();

  setInterval(() => {
    const now = Date.now();
    for (const [token, s] of sessions) if (s.expires < now) sessions.delete(token);
  }, 10 * 60e3).unref();

  const tokenOf = (req: Request) => {
    const header = req.headers.cookie ?? "";
    for (const part of header.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return v.join("=");
    }
    return undefined;
  };
  const sessionOf = (req: Request) => {
    const token = tokenOf(req);
    const s = token ? sessions.get(token) : undefined;
    if (!s || s.expires < Date.now()) return undefined;
    return s;
  };
  const setCookie = (res: Response, token: string, maxAgeSec: number) =>
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`);

  const who = (req: Request) => req.ip ?? "?";

  // ----- sign-in -----

  // Wrong passwords are counted by the blocklist: 5 in a row ban the device for 5 minutes, 10 for good.
  router.post("/login", async (req, res) => {
    // A device that keeps guessing is locked out before any password work is done.
    const locked = blocklist.status("login", req.ip);
    if (locked.blocked) return void res.status(429).json({ error: blockMessage(locked) });
    const username = String(req.body?.username ?? "").slice(0, 100);
    const password = String(req.body?.password ?? "").slice(0, 200);
    let result: Awaited<ReturnType<AdminAuth["verify"]>>;
    try {
      result = await auth.verify(username, password);
    } catch (e) {
      console.error("admin: login unavailable:", (e as Error).message);
      return void res.status(500).json({ error: (e as Error).message });
    }
    if (!result) {
      console.warn(`admin: failed sign-in from ${who(req)}`);
      const after = blocklist.fail("login", req.ip);
      return void res.status(after.blocked ? 429 : 401).json({ error: after.blocked ? blockMessage(after) : "Wrong username or password." });
    }
    blocklist.succeed("login", req.ip);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { ...result, expires: Date.now() + SESSION_MS });
    setCookie(res, token, SESSION_MS / 1000);
    console.log(`admin: ${result.username} signed in from ${who(req)}${result.mustChangePassword ? " (default password: change required)" : ""}`);
    res.json({ authenticated: true, ...result, adminTheme: settings.adminTheme } satisfies AdminSession);
  });

  router.get("/session", (req, res) => {
    const s = sessionOf(req);
    const adminTheme = settings.adminTheme; // the sign-in form wears it too
    res.json((s ? { authenticated: true, username: s.username, mustChangePassword: s.mustChangePassword, adminTheme } : { authenticated: false, adminTheme }) satisfies AdminSession);
  });

  router.post("/logout", (req, res) => {
    const token = tokenOf(req);
    if (token) sessions.delete(token);
    setCookie(res, "", 0);
    res.json({ ok: true });
  });

  // ----- everything below needs a session -----

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const s = sessionOf(req);
    if (!s) return void res.status(401).json({ error: "Sign in first." });
    res.locals.session = s;
    next();
  };
  router.use(requireSession);

  router.post("/password", async (req, res) => {
    const s = res.locals.session as Session;
    const current = String(req.body?.current ?? "");
    const next = String(req.body?.next ?? "");
    // Guessing the current password from a stolen session counts like a wrong sign-in.
    const locked = blocklist.status("login", req.ip);
    if (locked.blocked) return void res.status(429).json({ error: blockMessage(locked) });
    if (!(await auth.verify(s.username, current))) {
      const after = blocklist.fail("login", req.ip);
      return void res.status(after.blocked ? 429 : 400).json({ error: after.blocked ? blockMessage(after) : "The current password is wrong." });
    }
    blocklist.succeed("login", req.ip);
    const problem = AdminAuth.passwordProblem(next);
    if (problem) return void res.status(400).json({ error: problem });
    if (next === current) return void res.status(400).json({ error: "The new password must be different." });
    await auth.setPassword(s.username, next);
    // Every other session is signed out; this one continues with full access.
    const mine = tokenOf(req);
    for (const token of sessions.keys()) if (token !== mine) sessions.delete(token);
    s.mustChangePassword = false;
    console.log(`admin: password changed by ${s.username}`);
    res.json({ ok: true });
  });

  // On the default password nothing else is available.
  router.use((_req, res, next) => {
    if ((res.locals.session as Session).mustChangePassword) return void res.status(403).json({ error: "Change the default password first.", mustChangePassword: true });
    next();
  });

  // ----- rooms -----

  const report = (r: Room): AdminRoomReport => {
    const state = r.state();
    const screenSocket = [...r.screens].map((id) => io.sockets.sockets.get(id)).find(Boolean);
    return {
      code: r.code,
      id: r.id,
      createdAt: r.createdAt,
      lastActive: r.lastActive,
      playCount: r.playCount,
      hostId: r.hostId,
      hostName: r.singers.get(r.hostId ?? "")?.name ?? null,
      screenConnected: r.screens.size > 0,
      screenHost: (screenSocket?.data as { host?: string } | undefined)?.host ?? null,
      cast: state.cast,
      paused: r.paused,
      settings: r.settings,
      nowPlaying: r.nowPlaying,
      queue: r.queue,
      history: r.history,
      singers: state.singers,
    };
  };

  router.get("/rooms", (_req, res) => {
    res.json({ now: Date.now(), rooms: rooms.list().map(report) });
  });

  router.post("/rooms", (_req, res) => {
    const room = rooms.create();
    if (!room) return void res.status(409).json({ error: "The server already has the maximum number of rooms." });
    room.say("created from the admin page");
    res.json({ room: report(room) });
  });

  router.delete("/rooms/:code", async (req, res) => {
    const ok = await rooms.delete(req.params.code, "This room was closed by the admin.");
    if (!ok) return void res.status(404).json({ error: "No such room." });
    res.json({ ok: true });
  });

  router.post("/rooms/:code/host", (req, res) => {
    const room = rooms.get(req.params.code);
    if (!room) return void res.status(404).json({ error: "No such room." });
    const target = room.singers.get(String(req.body?.singerId ?? ""));
    if (!target || target.screen) return void res.status(400).json({ error: "Pick a singer in this room." });
    if (target.id === room.hostId) return void res.status(400).json({ error: `${target.name} is already the host.` });
    if (!room.assignHost(target.id)) return void res.status(400).json({ error: "Couldn't assign host." });
    res.json({ room: report(room) });
  });

  // Pair a room with a YouTube link code, or stop casting (the same paths as the host's menu).
  router.post("/rooms/:code/cast", async (req, res) => {
    const room = rooms.get(req.params.code);
    if (!room) return void res.status(404).json({ error: "No such room." });
    const result = await room.pairCast(String(req.body?.code ?? ""));
    if ("error" in result) return void res.status(400).json({ error: result.error });
    res.json({ room: report(room) });
  });

  router.delete("/rooms/:code/cast", async (req, res) => {
    const room = rooms.get(req.params.code);
    if (!room) return void res.status(404).json({ error: "No such room." });
    if (!room.lounge) return void res.status(400).json({ error: "No YouTube cast is paired." });
    await room.useScreen("The admin stopped the YouTube cast.");
    res.json({ room: report(room) });
  });

  // The same settings the room's host has: everyone-can-control, fair queue, colour preset.
  router.put("/rooms/:code/settings", (req, res) => {
    const room = rooms.get(req.params.code);
    if (!room) return void res.status(404).json({ error: "No such room." });
    const { openControls, fairQueue, theme } = req.body ?? {};
    if (theme !== undefined && !isTheme(theme)) return void res.status(400).json({ error: "Unknown colour preset." });
    if ([openControls, fairQueue].some((v) => v !== undefined && typeof v !== "boolean")) return void res.status(400).json({ error: "Settings are on or off." });
    room.updateSettings({ openControls, fairQueue, theme });
    res.json({ room: report(room) });
  });

  // Every song played in the room (the report's `history` is only the last 30).
  router.get("/rooms/:code/plays", async (req, res) => {
    const room = rooms.get(req.params.code);
    if (!room) return void res.status(404).json({ error: "No such room." });
    res.json({ plays: await playLog.plays(room.id) });
  });

  // ----- blocked devices -----

  const blocklistReport = (req: Request): BlocklistReport => ({
    yourAddress: deviceKey(req.ip),
    permanent: blocklist.list().map((e) => ({ address: e.key, since: e.since, scope: e.scope })),
    temporary: blocklist.temporary().map((t) => ({ address: t.key, scope: t.scope, fails: t.fails, retryAfterMs: t.retryAfterMs })),
  });
  const ADDRESS = /^[0-9a-f:.]{2,45}$/i;

  router.get("/blocklist", (req, res) => void res.json(blocklistReport(req)));

  router.post("/blocklist", (req, res) => {
    const address = deviceKey(String(req.body?.address ?? "").trim());
    if (!ADDRESS.test(address)) return void res.status(400).json({ error: "Enter an IP address, like 192.168.1.20." });
    if (address === deviceKey(req.ip)) return void res.status(400).json({ error: "That is this device. Blocking it would lock you out." });
    if (!blocklist.block(address)) return void res.status(409).json({ error: "That device is already blocked." });
    console.log(`admin: ${address} blocked by ${(res.locals.session as Session).username}`);
    res.json(blocklistReport(req));
  });

  // Lifts a permanent ban, or ends a temporary one early and clears its failure count.
  router.delete("/blocklist/:address", (req, res) => {
    if (!blocklist.unblock(String(req.params.address))) return void res.status(404).json({ error: "That device is not blocked." });
    res.json(blocklistReport(req));
  });

  // ----- appearance -----

  // Colour preset of the admin pages only (rooms have their own, in their settings).
  router.put("/theme", async (req, res) => {
    const theme = req.body?.theme;
    if (!isTheme(theme)) return void res.status(400).json({ error: "Unknown colour preset." });
    await settings.setAdminTheme(theme);
    console.log(`admin: admin colour preset set to ${theme}`);
    res.json({ theme });
  });

  // ----- debug -----

  // Log every YouTube cast command and TV event (otherwise only the important ones).
  router.get("/cast-log", (_req, res) => res.json({ verbose: castLog.verbose }));
  router.put("/cast-log", async (req, res) => {
    if (typeof req.body?.verbose !== "boolean") return void res.status(400).json({ error: "verbose must be true or false." });
    castLog.verbose = req.body.verbose;
    await settings.setVerboseCastLog(req.body.verbose);
    console.log(`admin: verbose cast logging ${req.body.verbose ? "on" : "off"}`);
    res.json({ verbose: castLog.verbose });
  });

  let lastCpu = { at: Date.now(), usage: process.cpuUsage() };
  router.get("/stats", async (_req, res) => {
    const now = Date.now();
    const usage = process.cpuUsage();
    const elapsedMs = Math.max(1, now - lastCpu.at);
    const usedMs = (usage.user - lastCpu.usage.user + (usage.system - lastCpu.usage.system)) / 1000;
    // Sample at most once a second so several open admin pages don't shrink the window.
    if (elapsedMs >= 1000) lastCpu = { at: now, usage };
    const mem = process.memoryUsage();
    const live = rooms.list();
    res.json({
      now,
      startedAt,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      pid: process.pid,
      cpuPercent: Math.round((usedMs / elapsedMs) * 1000) / 10,
      cpuCores: os.cpus().length,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, systemTotal: os.totalmem(), systemFree: os.freemem() },
      sockets: io.engine.clientsCount,
      rooms: live.length,
      singersOnline: live.reduce((n, r) => n + [...r.singers.values()].filter((s) => !s.screen && s.sockets.size > 0).length, 0),
      dataDir,
      logBytes: await logger.totalBytes(),
    } satisfies AdminStats);
  });

  // Performance over time: ?hours=1..168 (7 days is all that's kept).
  router.get("/metrics", (req, res) => {
    const hours = Math.max(1 / 60, Math.min(168, Number(req.query.hours) || 24));
    res.json(metrics.query(hours * 3600e3) satisfies MetricHistory);
  });

  const limitOf = (req: Request) => Math.max(1, Math.min(2000, Number(req.query.limit) || 300));

  router.get("/logs", async (req, res) => {
    // ?day=YYYY-MM-DD shows one day's file; without it, the most recent lines across days
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day ?? "")) ? String(req.query.day) : undefined;
    res.json({
      lines: await logger.tail(null, limitOf(req), day),
      days: await logger.systemDays(),
      rooms: await logger.roomsWithLogs(),
      live: rooms.list().map((r) => r.code),
    });
  });

  router.get("/logs/:code", async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    if (!/^[A-Z2-9]{4}$/.test(code)) return void res.status(400).json({ error: "Bad room code." });
    res.json({ lines: await logger.tail(code, limitOf(req)) });
  });

  return router;
}
