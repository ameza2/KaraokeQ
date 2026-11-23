import { createServer } from "node:http";
import compression from "compression";
import express from "express";
import { Server } from "socket.io";
import type { ClientToServer, ServerToClient } from "@karaoke/shared";
import { RoomRegistry } from "./rooms/index.ts";
import { FilePlayLog, dataDir } from "./playLog.ts";
import { startShareHostWatch } from "./net.ts";
import { Logger } from "./logger.ts";
import { publicRoutes } from "./http/publicRoutes.ts";
import { errorHandler } from "./http/errors.ts";
import { staticClient } from "./http/staticClient.ts";
import { securityHeaders } from "./http/security.ts";
import { registerSocketHandlers, type SocketData } from "./sockets/index.ts";

// Capture console output into the log files before anything else logs.
const logger = new Logger(dataDir());
logger.captureConsole();

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(compression()); // gzip text responses over 1kB (the client bundle: 341kB -> ~108kB)
app.use(securityHeaders);
app.use(express.json({ limit: "20kb" }));

const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient, {}, SocketData>(http, { cors: { origin: true }, maxHttpBufferSize: 16_000 });
const playLog = new FilePlayLog(dataDir());
console.log(`data folder: ${dataDir()} (play log, logs, settings, admin login)`);
const rooms = new RoomRegistry(io, playLog);

// ---------- HTTP API ----------
startShareHostWatch();
publicRoutes(app, { rooms, playLog });
staticClient(app); // keep last: the /api 404 catch-all and the built client
app.use(errorHandler); // after every route

// ---------- Realtime ----------
registerSocketHandlers(io, rooms);

http.listen(PORT, () => {
  console.log(`karaoke server listening on http://localhost:${PORT}`);
});

process.on("uncaughtException", (e) => {
  console.error("uncaught exception:", e);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 200).unref(); // let the log line reach the file
});
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
