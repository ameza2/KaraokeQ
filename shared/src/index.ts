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
  /** The page these results are (0-based). It can be lower than the one asked for when that is past the end. */
  page: number;
  pageSize: number;
  total: number; // results known so far for this search (all pages, after filtering)
  /** true = YouTube has nothing more for this search, so total is exact; false = more can still be fetched. */
  complete: boolean;
  hasMore: boolean; // there is a page after this one
  hidden: number; // results dropped because they can't play on the current output
  /** Changes when the server rebuilds this search; paging across versions would mix two result lists. */
  version: string;
  /** The server is rationing YouTube requests: this is the furthest page ready for now; try Next again shortly. */
  busy?: boolean;
}

// ---------- public HTTP API ----------
// Response bodies of the routes in server/src/http/publicRoutes.ts. The server checks its
// replies against these (`satisfies`) and the client reads them, so a change breaks both builds.

/** Any failed API call: a status code and `{error}`. */
export interface ApiError {
  error: string;
}
/** POST /api/rooms. A room made by a screen gets no host token. */
export interface CreateRoomResponse {
  code: string;
  hostToken?: string;
}
/** GET /api/rooms/:code */
export interface RoomExistsResponse {
  exists: boolean;
}
/** GET /api/suggest */
export interface SuggestResponse {
  suggestions: string[];
}
/** GET /api/info: how other devices should reach the server. */
export interface ServerInfo {
  lanIps: string[];
  shareHost: string | null; // e.g. 192-168-0-5.nip.io
}

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export const MODE_LABELS: Record<OutputMode, { name: string; hint: string }> = {
  screen: { name: "Web Player", hint: "Only showing videos that can play in the browser." },
  lounge: { name: "YouTube", hint: "Casting to the TV's YouTube app, so every video works." },
};

/** Thumbnails are not sent with queue items: build the URL from the video id (thumbUrl). */
export const thumbUrl = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

export interface QueueItem extends Omit<VideoResult, "thumb"> {
  id: string;
  singerId: string;
  singerName: string;
  addedAt: number;
  playedAt?: number; // set on history entries
  /** Started on the TV itself (its remote), not queued here. Never logged or replayed. */
  external?: boolean;
}

export type OutputMode = "screen" | "lounge";

/** What took over a room's output: another screen, or the YouTube cast. */
export type ReplacedBy = "screen" | "cast";

/** Why the screen is holding a song: a raw address, another device, or the account's plan limit. */
export type BlockReason = "ip" | "device" | "limit";

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
  /** Songs in the room history (the list itself is fetched with "history:get" when someone opens it). */
  historyCount: number;
  /** Changes whenever the history does, so an open history list knows to refetch. */
  historyRev: number;
  canGoBack: boolean; // ⏮ can return to the previous song (one step only)
  hostId: string | null;
  /** Device id of the room's active screen. That device gets the host's permissions. */
  screenId: string | null; // singerId of the current host (null until someone claims a TV room)
  settings: RoomSettings;
  /** The host has had no connected device for a while: any singer may claim host. */
  hostClaimable: boolean;
  /** The YouTube cast is still applying a pause/resume: phones disable the button until the TV confirms. */
  pausePending: boolean;
  /** The YouTube cast, paired through the TV's "Link with TV code" (mode "lounge" while it's the output). */
  cast: { name: string; connected: boolean } | null;
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
  /** For "error": the video had reached the playing state before it failed (so it wasn't blocked at load). */
  played?: boolean;
}

export interface Notice {
  level: "info" | "error";
  message: string;
}

/** `needsScreenCode`: the screen must send the room's screen code (see `screen:join`). */
export type Ack<T = {}> = ({ ok: true } & T) | { ok: false; error: string; needsScreenCode?: boolean };

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
  /** The room history, most recent first (capped at 30). */
  "history:get": (ack: (r: Ack<{ items: QueueItem[] }>) => void) => void;
  "history:replay": (p: { itemId: string }, ack: (r: Ack) => void) => void;
  "playback:pause": () => void;
  "playback:resume": () => void;
  "playback:seek": (p: { seconds: number }) => void;
  "host:transfer": (p: { singerId: string }, ack: (r: Ack) => void) => void;
  /** Any singer: take host once the host has been fully disconnected for 5 minutes. */
  "host:claim": (ack: (r: Ack) => void) => void;
  "settings:update": (p: Partial<RoomSettings>) => void;
  /** Host/screen: pair the TV's YouTube app with the 12-digit "Link with TV code" and play there. */
  "cast:pair": (p: { code: string }, ack: (r: Ack<{ name: string }>) => void) => void;
  /** Host/screen: stop casting and go back to the browser screen. */
  "cast:unpair": () => void;
  "screen:progress": (p: Progress) => void;
  /**
   * Become the room's screen. A brand-new room (no host, no screen yet) lets the first screen in
   * for free; after that it needs the room's `screenCode` or the host's `hostToken`. The ack
   * returns the code to the screen, which keeps it for reconnects.
   */
  "screen:join": (
    p: { code: string; deviceId?: string; host?: string; screenCode?: string; hostToken?: string },
    ack: (r: Ack<{ state: RoomState; screenCode: string }>) => void,
  ) => void;
  /** Host or screen: the room's screen code, to type on another screen. */
  "screen:code": (ack: (r: Ack<{ screenCode: string }>) => void) => void;
  "screen:event": (e: ScreenEvent) => void;
}

export interface ServerToClient {
  "room:state": (s: RoomState) => void;
  "screen:command": (c: ScreenCommand) => void;
  "playback:progress": (p: Progress) => void;
  /** Sent to a screen right before it's disconnected because another screen joined or a YouTube cast was paired. */
  "screen:replaced": (by: ReplacedBy) => void;
  /** This screen's address (a raw IP) is blocked for the current video; others may play it. */
  "screen:blocked": (p: { itemId: string; shareHost: string | null; reason: BlockReason }) => void;
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

/** Devices locked out for guessing secrets (admin password, room codes, screen codes). */
export interface BlocklistReport {
  /** The device asking, so the admin sees which entry is their own. */
  yourAddress: string;
  /** Blocked until the admin lifts it. */
  permanent: { address: string; since: string; scope: string }[];
  /** Blocked for a few minutes. */
  temporary: { address: string; scope: string; fails: number; retryAfterMs: number }[];
}

/** One time a device was locked out, and how it ended. */
export interface DeviceBan {
  kind: "temporary" | "permanent";
  /** What was being guessed: "login", "code", "screen", or "admin" for a block by hand. */
  scope: string;
  by: "auto" | "admin";
  at: string;
  /** End of a temporary ban. */
  until: string | null;
  /** Set when the admin lifted it early. */
  liftedAt: string | null;
}

/**
 * Everything the server remembers about one device (a network address), kept for good in
 * `data/devices/<address>.json`. Lists are capped so a file stays small.
 */
export interface DeviceRecord {
  address: string;
  firstSeen: string;
  lastSeen: string;
  /** Socket connections opened. */
  connections: number;
  status: "ok" | "blocked";
  /** Why and when the device is blocked for good (null while status is "ok"). */
  blocked: { at: string; scope: string; by: "auto" | "admin" } | null;
  /** The admin's own note about this device. */
  note: string;
  /** Wrong guesses per scope, all time. */
  failures: Record<string, number>;
  lastFailureAt: string | null;
  bans: DeviceBan[];
  /** Names it has joined with (the person can change; the device is the address). */
  names: { name: string; singerId: string; lastSeen: string }[];
  rooms: { code: string; role: "singer" | "host" | "screen"; joins: number; firstAt: string; lastSeen: string }[];
  userAgents: { agent: string; lastSeen: string }[];
}

/** A device with at least one open connection right now. */
export interface ActiveDevice {
  address: string;
  connections: number;
  connectedSince: string;
  people: { name: string; room: string | null; role: string | null }[];
}

export interface DevicesReport {
  /** The device asking, so the admin sees which one is their own. */
  yourAddress: string;
  /** Devices on record. */
  total: number;
  blocked: DeviceRecord[];
  temporary: { address: string; scope: string; fails: number; retryAfterMs: number }[];
  active: ActiveDevice[];
  /** Most recently seen first, limited (and filtered by the search box). */
  recent: DeviceRecord[];
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
  /** What another device types to become this room's screen (admin only: never in `room:state`). */
  screenCode: string;
  /** Hostname the screen page is open at, when one is connected. */
  screenHost: string | null;
  /** The YouTube cast, when one is paired. */
  cast: { name: string; connected: boolean } | null;
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
