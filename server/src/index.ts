import { createServer } from "node:http";
import compression from "compression";
import express from "express";
import { Server } from "socket.io";
import type { ClientToServer, ServerToClient } from "@karaoke/shared";
import { RoomRegistry } from "./rooms/index.ts";
import { FilePlayLog, dataDir } from "./playLog.ts";
import { sameOrigin, socketAddress, startShareHostWatch, trustedProxies } from "./net.ts";
import { Logger } from "./logger.ts";
import { SiteSettings } from "./siteSettings.ts";
import { AdminAuth, FileCredentialStore } from "./admin/credentials.ts";
import { adminRouter } from "./admin/routes.ts";
import { Metrics } from "./metrics.ts";
import { Blocklist, blockMessage } from "./blocklist.ts";
import { castLog } from "./playback/lounge.ts";
import { publicRoutes } from "./http/publicRoutes.ts";
import { installFakeYoutube } from "./searchFake.ts";
import { errorHandler } from "./http/errors.ts";
import { staticClient } from "./http/staticClient.ts";
import { noStore, securityHeaders } from "./http/security.ts";
import { cspHeader, cspReportRoute } from "./http/csp.ts";
import { registerSocketHandlers, type SocketData } from "./sockets/index.ts";

// Capture console output into the log files before anything else logs.
const logger = new Logger(dataDir());
logger.captureConsole();

const blocklist = new Blocklist(dataDir(), { tempMs: Number(process.env.KARAOKE_BLOCK_TEMP_MS) || undefined }); // the env var is for tests

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
app.set("trust proxy", trustedProxies()); // 0 unless KARAOKE_TRUST_PROXY says how many proxies are in front
app.disable("x-powered-by");
app.use(compression()); // gzip text responses over 1kB (the client bundle: 341kB -> ~108kB)
app.use(securityHeaders);
app.use((req, res, next) => {
  // A device blocked for good gets nothing from the server, not even the pages.
  if (!blocklist.isPermanent(req.ip)) return next();
  res.status(403).json({ error: blockMessage({ blocked: true, permanent: true }) });
});
app.use(cspHeader);
app.use(express.json({ limit: "20kb" }));

const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient, {}, SocketData>(http, {
  // Same-origin only: the page and the socket come from one server, so no CORS is needed.
  allowRequest: (req, done) => done(null, sameOrigin(req.headers.origin, req.headers.host)),
  maxHttpBufferSize: 16_000,
});
const playLog = new FilePlayLog(dataDir());
console.log(`data folder: ${dataDir()} (play log, logs, settings, admin login)`);
io.use((socket, next) => (blocklist.isPermanent(socketAddress(socket)) ? next(new Error(blockMessage({ blocked: true, permanent: true }))) : next()));
const rooms = new RoomRegistry(io, playLog);
const siteSettings = new SiteSettings(dataDir());
castLog.verbose = siteSettings.verboseCastLog;
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

// ---------- HTTP API ----------
startShareHostWatch();
if (process.env.KARAOKE_FAKE_YOUTUBE === "1") installFakeYoutube(app); // tests and the stress test only
publicRoutes(app, { rooms, blocklist });
cspReportRoute(app);
app.use("/api/admin", noStore, adminRouter({ io, rooms, playLog, auth: new AdminAuth(credentials), settings: siteSettings, logger, metrics, blocklist, dataDir: dataDir() }));
staticClient(app); // keep last: the /api 404 catch-all and the built client
app.use(errorHandler); // after every route

// ---------- Realtime ----------
registerSocketHandlers(io, rooms, blocklist);

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
