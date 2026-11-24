// Test harness: boots the real server on a free port with a throwaway data folder,
// and gives tests small socket clients that track the latest room state.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io, type Socket } from "socket.io-client";
import type { Ack, ClientToServer, RoomState, ServerToClient, VideoResult } from "@karaoke/shared";

export type TestSocket = Socket<ServerToClient, ClientToServer>;

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export interface TestServer {
  url: string;
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "karaoke-test-"));
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), KARAOKE_DATA_DIR: dataDir, KARAOKE_HOST_AWAY_MS: "700", KARAOKE_ROOM_CREATE_PER_MIN: "10000", KARAOKE_ONE_ROOM_PER_DEVICE: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
    const onData = (d: Buffer) => {
      out += d;
      if (out.includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", (d) => (out += d));
    child.on("exit", (code) => reject(new Error(`server exited early (${code}):\n${out}`)));
  });
  return {
    url: `http://localhost:${port}`,
    async stop() {
      child.removeAllListeners("exit");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill();
      await new Promise((r) => setTimeout(r, 200));
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may still hold a log file */ }
    },
  };
}

export async function createRoom(url: string, by: "client" | "screen" = "client") {
  const res = await fetch(`${url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by }) });
  return (await res.json()) as { code: string; hostToken?: string };
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns something truthy (or throw after `ms`). */
export async function until<T>(fn: () => T | undefined | false | null, what = "condition", ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(15);
  }
}

export class Client {
  state!: RoomState;
  isHost = false;
  hostToken?: string;
  notices: string[] = [];
  commands: unknown[] = [];
  replacedBy: string | null = null;
  blocked: { itemId: string; reason: string }[] = [];
  readonly socket: TestSocket;

  constructor(url: string, readonly singerId: string, readonly name = singerId) {
    this.socket = io(url, { transports: ["websocket"], forceNew: true }) as TestSocket;
    this.socket.on("room:state", (s) => (this.state = s));
    this.socket.on("notice", (n) => this.notices.push(n.message));
    this.socket.on("screen:command", (c) => this.commands.push(c));
    this.socket.on("screen:replaced", (by) => (this.replacedBy = by));
    this.socket.on("screen:blocked", (b) => this.blocked.push(b));
    this.socket.on("host:token", (p) => (this.hostToken = p.hostToken));
  }

  emit<K extends keyof ClientToServer>(ev: K, ...args: Parameters<ClientToServer[K]>) {
    (this.socket.emit as (...a: unknown[]) => void)(ev, ...args);
  }

  ask<T = {}>(ev: keyof ClientToServer, payload?: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => {
      if (payload === undefined) (this.socket.emit as (...a: unknown[]) => void)(ev, resolve);
      else (this.socket.emit as (...a: unknown[]) => void)(ev, payload, resolve);
    });
  }

  async join(code: string, hostToken?: string, asScreen = false) {
    const r = await this.ask<{ state: RoomState; isHost: boolean; hostToken?: string }>("room:join", { code, singerId: this.singerId, name: this.name, hostToken, asScreen });
    if (r.ok) {
      this.state = r.state;
      this.isHost = r.isHost;
      if (r.hostToken) this.hostToken = r.hostToken;
    }
    return r;
  }

  /** Join as the room's screen (the /screen page's role). */
  async joinScreen(code: string, host = "test.local") {
    const r = await this.ask<{ state: RoomState }>("screen:join", { code, deviceId: this.singerId, host });
    if (r.ok) this.state = r.state;
    return r;
  }

  add(video: VideoResult) {
    return this.ask("queue:add", { video });
  }

  /** Wait for the next room state that satisfies `pred` (or the current one). */
  waitState(pred: (s: RoomState) => boolean, what = "room state") {
    return until(() => this.state && pred(this.state) && this.state, what);
  }

  close() {
    this.socket.close();
  }
}

let n = 0;
export function video(label = ""): VideoResult {
  n++;
  const id = `vid${String(n).padStart(8, "0")}`.slice(0, 11);
  return { videoId: id, title: `Song ${label || n}`, channel: "Test", duration: "3:00", thumb: "" };
}
