import { createServer } from "node:http";
import express from "express";
import { Server } from "socket.io";
import type { ClientToServer, ServerToClient } from "@karaoke/shared";
import { RoomRegistry } from "./rooms/index.ts";
import { FilePlayLog, dataDir } from "./playLog.ts";
import { startShareHostWatch } from "./net.ts";
import { Logger } from "./logger.ts";
import { SiteSettings } from "./siteSettings.ts";
import { AdminAuth, FileCredentialStore } from "./admin/credentials.ts";
import { adminRouter } from "./admin/routes.ts";
import { Metrics } from "./metrics.ts";
import { castLog } from "./playback/lounge.ts";
import { publicRoutes } from "./http/publicRoutes.ts";
import { staticClient } from "./http/staticClient.ts";
import { noStore, securityHeaders } from "./http/security.ts";
import { registerSocketHandlers, type SocketData } from "./sockets/index.ts";

// Capture console output into the log files before anything else logs.
const logger = new Logger(dataDir());
logger.captureConsole();

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(express.json({ limit: "20kb" }));

const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient, {}, SocketData>(http, { cors: { origin: true }, maxHttpBufferSize: 16_000 });
const playLog = new FilePlayLog(dataDir());
console.log(`data folder: ${dataDir()} (play log, logs, settings, admin login)`);
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
publicRoutes(app, { rooms, playLog });
app.use("/api/admin", noStore, adminRouter({ io, rooms, playLog, auth: new AdminAuth(credentials), settings: siteSettings, logger, metrics, dataDir: dataDir() }));
staticClient(app); // keep last: the /api 404 catch-all and the built client

// ---------- Realtime ----------
registerSocketHandlers(io, rooms);

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
