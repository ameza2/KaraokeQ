// Types shared between the server and the client.

export interface VideoResult {
  videoId: string;
  title: string;
  channel: string;
  duration: string;
  thumb: string;
  /** false = uploader blocked playback outside youtube.com (won't work on /screen). */
  embeddable?: boolean;
}

// ---------- colour presets ----------
// Each room has its own preset (chosen by its host); the admin page has one too.

export const THEMES = ["orange", "blue", "white", "green"] as const;
export type ThemeName = (typeof THEMES)[number];
export const THEME_LABELS: Record<ThemeName, string> = { orange: "Orange", blue: "Blue", white: "White", green: "Green" };
export const DEFAULT_THEME: ThemeName = "orange";

export interface RoomSettings {
  /** Everyone gets the host's playback/queue controls (skip, back, seek, reorder, remove). */
  openControls: boolean;
  /**
   * Fair queue (default on): a new request goes after every other singer's song of the
   * same round, so people with fewer songs queued go first. Off: first come, first served.
   */
  fairQueue: boolean;
  /** The room's colour preset, on every device in the room. */
  theme: ThemeName;
}

export interface SearchPage {
  results: VideoResult[];
  hasMore: boolean;
  hidden: number; // results dropped because they can't play on the current output
}

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export const MODE_LABELS: Record<OutputMode, { name: string; hint: string }> = {
  screen: { name: "Web player", hint: "Only showing videos that can play on the TV screen page." },
  lounge: { name: "YouTube TV app", hint: "Casting to the TV's YouTube app, so every video works." },
};

export interface QueueItem extends VideoResult {
  id: string;
  singerId: string;
  singerName: string;
  addedAt: number;
  playedAt?: number; // set on history entries
}

export type OutputMode = "screen" | "lounge";

export interface Singer {
  id: string;
  name: string;
  screen?: boolean; // the room's screen device (not a person)
  online: boolean;
}

export interface RoomState {
  code: string;
  mode: OutputMode;
  nowPlaying: QueueItem | null;
  paused: boolean;
  queue: QueueItem[];
  singers: Singer[];
  screens: number; // connected /screen displays
  history: QueueItem[]; // most recent first, capped
  canGoBack: boolean; // ⏮ can return to the previous song (one step only)
  hostId: string | null;
  /** Device id of the room's active screen. That device gets the host's permissions. */
  screenId: string | null; // singerId of the current host (null until someone claims a TV room)
  settings: RoomSettings;
}

// Commands the server sends to a /screen display.
export type ScreenCommand =
  | { action: "play"; item: QueueItem; startAt?: number; paused?: boolean }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "seek"; seconds: number }
  | { action: "stop" };

/** Playback position, reported by a screen and relayed to phones. */
export interface Progress {
  itemId: string;
  time: number; // seconds
  duration: number; // seconds (0 = unknown yet)
}

// Events a /screen display reports back.
export interface ScreenEvent {
  type: "ended" | "error" | "playing" | "paused" | "skip-blocked";
  itemId: string;
  errorCode?: number;
}

export interface Notice {
  level: "info" | "error";
  message: string;
}

export type Ack<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export interface ClientToServer {
  "room:join": (
    p: { code: string; singerId: string; name: string; hostToken?: string; asScreen?: boolean },
    ack: (r: Ack<{ state: RoomState; isHost: boolean; hostToken?: string }>) => void,
  ) => void;
  "singer:rename": (p: { name: string }) => void;
  "queue:add": (p: { video: VideoResult }, ack: (r: Ack) => void) => void;
  "queue:remove": (p: { itemId: string }) => void;
  "queue:move": (p: { itemId: string; toIndex: number }) => void;
  "playback:skip": () => void;
  "playback:rewind": () => void;
  "history:replay": (p: { itemId: string }, ack: (r: Ack) => void) => void;
  "playback:pause": () => void;
  "playback:resume": () => void;
  "playback:seek": (p: { seconds: number }) => void;
  "host:transfer": (p: { singerId: string }, ack: (r: Ack) => void) => void;
  "settings:update": (p: Partial<RoomSettings>) => void;
  "screen:progress": (p: Progress) => void;
  "screen:join": (p: { code: string; deviceId?: string; host?: string }, ack: (r: Ack<{ state: RoomState }>) => void) => void;
  "screen:event": (e: ScreenEvent) => void;
}

export interface ServerToClient {
  "room:state": (s: RoomState) => void;
  "screen:command": (c: ScreenCommand) => void;
  "playback:progress": (p: Progress) => void;
  /** Sent to a screen right before it's disconnected because a newer screen joined. */
  "screen:replaced": () => void;
  /** This screen's address (a raw IP) is blocked for the current video; others may play it. */
  "screen:blocked": (p: { itemId: string; shareHost: string | null; reason: "ip" | "device" }) => void;
  /** Sent to a singer who was just made host: their proof for future reconnects. */
  "host:token": (p: { hostToken: string }) => void;
  /** The room was deleted (by the admin). The socket is disconnected right after. */
  "room:closed": (p: { message: string }) => void;
  notice: (n: Notice) => void;
}

// ---------- admin ----------

export interface AdminSession {
  authenticated: boolean;
  username?: string;
  /** Still on the default password: everything else is locked until it's changed. */
  mustChangePassword?: boolean;
  /** Colour preset of the admin pages (also sent before sign-in, for the sign-in form). */
  adminTheme: ThemeName;
}

export interface AdminRoomReport {
  code: string;
  id: string;
  createdAt: number;
  lastActive: number;
  /** Total songs that have left the stage (the full play log, not just the last 30). */
  playCount: number;
  hostId: string | null;
  hostName: string | null;
  screenConnected: boolean;
  /** Hostname the screen page is open at, when one is connected. */
  screenHost: string | null;
  paused: boolean;
  settings: RoomSettings;
  nowPlaying: QueueItem | null;
  queue: QueueItem[];
  /** Last 30 played, newest first (same list singers see). */
  history: QueueItem[];
  singers: Singer[];
}

export interface AdminStats {
  now: number;
  startedAt: number;
  uptimeSec: number;
  node: string;
  platform: string;
  pid: number;
  /** Share of one CPU core used by the server since the previous sample (0-100+). */
  cpuPercent: number;
  cpuCores: number;
  memory: { rss: number; heapUsed: number; heapTotal: number; systemTotal: number; systemFree: number };
  sockets: number;
  rooms: number;
  singersOnline: number;
  dataDir: string;
  logBytes: number;
}

/** One bucket of the performance history (averages, except where noted). */
export interface MetricPoint {
  at: number;
  cpu: number; // % of one core
  cpuMax: number; // highest sample in the bucket
  rss: number; // bytes
  heap: number; // bytes
  sockets: number; // highest in the bucket
  rooms: number; // highest in the bucket
  singers: number; // highest in the bucket
}

export interface MetricHistory {
  /** Width of one bucket; a gap wider than this means the server was off. */
  bucketMs: number;
  from: number;
  to: number;
  points: MetricPoint[];
  systemMemory: number;
}

export interface LogLine {
  at: number;
  level: "info" | "warn" | "error";
  /** Room code for room-scoped lines. */
  room?: string;
  message: string;
}
