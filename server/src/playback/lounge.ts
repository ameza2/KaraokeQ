import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { QueueItem } from "@karaoke/shared";
import type { PlayOptions, PlaybackOutput } from "./output.ts";

/**
 * Drives the TV's native YouTube app through YouTube's (unofficial) "Lounge"
 * protocol, the same one the phone "cast" button uses.
 *
 *  - pairCast(code)    "Link with TV code" -> screenId + loungeToken
 *  - LoungeOutput    bind session, one setPlaylist per song, long-poll event stream
 *
 * The queue stays in the room; the TV only ever gets one video at a time. Because
 * the TV's own app plays the video, it is signed in to whatever account the TV is
 * (so a Premium account on the TV means no ads) and embed blocks don't apply.
 * Nothing here is stored on disk: the pairing lives with the room.
 *
 * Events: "ended"(itemId), "error"(itemId), "progress"({itemId,time,duration}),
 * "remote-state"("playing" | "paused") when someone uses the TV remote,
 * "link"(connected) and "lost" (the TV stayed unreachable for LOST_AFTER_MS).
 */

const BASE = "https://www.youtube.com/api/lounge";
const APP_NAME = "Karaoke Queue"; // shown on the TV as the remote's name; nothing personal
const LOST_AFTER_MS = 45_000;
const START_TIMEOUT_MS = 25_000;
const POLL_NOW_PLAYING_MS = 3_000;
const SWITCH_GRACE_MS = 20_000; // after sending a song, events about other videos are the old one
/**
 * Verbose cast logging (admin Debug tab): every command and every TV event. Off by default,
 * because the 3s poll alone fills the log; the normal log keeps song sends, stops, confirmations and warnings.
 */
export const castLog = { verbose: false };

const PENDING_MS = 6_000; // how long a pause/resume waits for the TV to confirm it
const IDLE_AFTER_MS = 4_000; // "stopped" must last this long before we treat the TV as idle

export interface CastTarget {
  screenId: string;
  loungeToken: string;
  name: string;
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** Exchange the 12-digit "Link with TV code" for the TV's lounge credentials. */
export async function pairCast(rawCode: string): Promise<CastTarget> {
  const code = String(rawCode ?? "").replace(/\D/g, "");
  if (code.length !== 12) throw new Error("The TV code is 12 digits (Settings → Link with TV code).");
  const res = await fetch(`${BASE}/pairing/get_screen`, {
    method: "POST",
    headers: FORM,
    body: form({ pairing_code: code }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404 || res.status === 400) throw new Error("YouTube didn't accept that code. Check it on the TV (codes expire).");
  if (!res.ok) throw new Error(`YouTube pairing failed (${res.status}).`);
  const json = (await res.json()) as { screen?: { screenId?: string; loungeToken?: string; name?: string } };
  const s = json.screen;
  if (!s?.screenId || !s.loungeToken) throw new Error("YouTube returned no TV for that code.");
  return { screenId: s.screenId, loungeToken: s.loungeToken, name: s.name || "YouTube TV" };
}

async function refreshToken(screenId: string): Promise<string> {
  const res = await fetch(`${BASE}/pairing/get_lounge_token_batch`, {
    method: "POST",
    headers: FORM,
    body: form({ screen_ids: screenId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
  const json = (await res.json()) as { screens?: { loungeToken?: string }[] };
  const t = json.screens?.[0]?.loungeToken;
  if (!t) throw new Error("token refresh returned no token");
  return t;
}

/** Parses the Lounge's chunked responses: `<length>\n<json array>` repeated. */
class ChunkParser {
  private buf = "";
  push(text: string): [number, unknown[]][] {
    this.buf += text;
    const out: [number, unknown[]][] = [];
    for (;;) {
      this.buf = this.buf.replace(/^\s+/, "");
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const n = parseInt(this.buf.slice(0, nl), 10);
      if (!Number.isFinite(n)) {
        this.buf = "";
        break;
      }
      if (this.buf.length < nl + 1 + n) break; // rest of this chunk hasn't arrived
      const body = this.buf.slice(nl + 1, nl + 1 + n);
      this.buf = this.buf.slice(nl + 1 + n);
      try {
        for (const e of JSON.parse(body) as [number, unknown[]][]) if (Array.isArray(e)) out.push(e);
      } catch {
        /* skip a damaged chunk */
      }
    }
    return out;
  }
}

class SessionExpired extends Error {}

/** A video the TV started by itself (someone used the TV remote). */
interface Ext {
  videoId: string;
  started: boolean;
  time: number;
  duration: number;
}

interface Current {
  item: QueueItem;
  started: boolean; // the TV reported it playing
  startAt: number;
  pauseOnStart: boolean;
  sent: boolean;
  sentAt: number;
  time: number;
  duration: number;
  watchdog?: NodeJS.Timeout;
}

export class LoungeOutput extends EventEmitter implements PlaybackOutput {
  readonly kind = "lounge" as const;
  connected = false;

  private readonly deviceId = randomUUID();
  private sid = "";
  private gsid = "";
  private aid = 0; // id of the last event received
  private ofs = 1; // next command offset (see send)
  private token: string;
  private closed = false;
  private abort = new AbortController();
  private lostTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private current: Current | null = null;
  private ext: Ext | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private tvVideoId = "";

  constructor(readonly screen: CastTarget) {
    super();
    this.token = screen.loungeToken;
  }

  get name() {
    return this.screen.name;
  }

  // ---------- session ----------

  private params(extra: Record<string, string>) {
    return new URLSearchParams({
      name: APP_NAME,
      loungeIdToken: this.token,
      device: "REMOTE_CONTROL",
      app: "youtube-desktop",
      VER: "8",
      v: "2",
      ...extra,
    });
  }

  private session(): Record<string, string> {
    return { SID: this.sid, gsessionid: this.gsid, AID: String(this.aid) };
  }

  /** Open a bind session and start listening. Rejects if the TV can't be reached. */
  async connect(): Promise<void> {
    await this.bind();
    void this.listen();
  }

  private async bind(): Promise<void> {
    this.sid = "";
    this.gsid = "";
    this.aid = 0;
    this.ofs = 1;
    // Same shape as pyytlounge's connect(): the token goes in the body, and the
    // capabilities (notably "que") tell the TV this remote can drive its queue.
    const post = () =>
      fetch(`${BASE}/bc/bind?RID=1&VER=8&CVER=1&auth_failure_option=send_error`, {
        method: "POST",
        headers: FORM,
        body: form({
          app: "web",
          "mdx-version": "3",
          name: APP_NAME,
          id: this.deviceId,
          device: "REMOTE_CONTROL",
          capabilities: "que,dsdtr,atp,vsp",
          magnaKey: "cloudPairedDevice",
          ui: "false",
          deviceContext: "user_agent=dunno&window_width_points=&window_height_points=&os_name=android&ms=",
          theme: "cl",
          loungeIdToken: this.token,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    let res = await post();
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      // the lounge token can expire; get a fresh one and try once more
      this.token = await refreshToken(this.screen.screenId);
      res = await post();
    }
    if (!res.ok) throw new Error(`The TV didn't accept the connection (${res.status}).`);
    this.consume(new ChunkParser().push(await res.text()));
    if (!this.sid || !this.gsid) throw new Error("The TV's YouTube app didn't answer. Open YouTube on the TV and try again.");
    this.setLink(true);
    void this.send("getNowPlaying").catch(() => {});
    this.pollTimer ??= setInterval(() => {
      if (this.connected) void this.send("getNowPlaying").catch(() => {});
    }, POLL_NOW_PLAYING_MS);
    this.pollTimer.unref();
  }

  /** Long-poll the event stream until disposed, rebinding when the session dies. */
  private async listen(): Promise<void> {
    let failures = 0;
    while (!this.closed) {
      try {
        await this.stream();
        failures = 0;
      } catch (err) {
        if (this.closed) return;
        this.setLink(false);
        failures++;
        const delay = Math.min(1000 * 2 ** Math.min(failures, 4), 15_000);
        if (!(err instanceof SessionExpired) || failures > 1) await new Promise((r) => setTimeout(r, delay));
        if (this.closed) return;
        try {
          await this.bind();
          failures = 0;
        } catch (e) {
          console.warn(`lounge: reconnect to "${this.name}" failed: ${(e as Error).message}`);
        }
      }
    }
  }

  private async stream(): Promise<void> {
    const q = this.params({ RID: "rpc", CI: "0", TYPE: "xmlhttp", ...this.session() });
    const res = await fetch(`${BASE}/bc/bind?${q}`, { signal: this.abort.signal });
    if (res.status === 400 || res.status === 404 || res.status === 410) throw new SessionExpired(`stream ${res.status}`);
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const parser = new ChunkParser();
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      this.consume(parser.push(dec.decode(chunk, { stream: true })));
    }
  }

  private async send(command: string, args: Record<string, string> = {}): Promise<void> {
    if (!this.connected) throw new Error("TV not connected");
    // ofs starts at 1 after the bind; RID is the offset after incrementing (first command: ofs 1, RID 2)
    const body: Record<string, string> = { count: "1", ofs: String(this.ofs), req0__sc: command };
    for (const [k, v] of Object.entries(args)) body[`req0_${k}`] = v;
    this.ofs++;
    const q = this.params({ RID: String(this.ofs), ...this.session() });
    const res = await fetch(`${BASE}/bc/bind?${q}`, { method: "POST", headers: FORM, body: form(body), signal: AbortSignal.timeout(10_000) });
    if (res.status === 400 || res.status === 404 || res.status === 410) {
      this.abort.abort(); // wake the listener so it rebinds
      this.abort = new AbortController();
      throw new SessionExpired(`command ${res.status}`);
    }
    if (!res.ok) throw new Error(`command ${command} failed (${res.status})`);
    const text = await res.text().catch(() => "");
    if (castLog.verbose || command === "setPlaylist" || command === "stopVideo") {
      console.log(`lounge[${this.name}] sent ${command} ${JSON.stringify(args)} -> ${res.status} ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    }
    // the reply to a command can carry events too
    this.consume(new ChunkParser().push(text));
  }

  // ---------- link state ----------

  private setLink(on: boolean) {
    if (this.closed) return;
    if (on) {
      if (this.lostTimer) clearTimeout(this.lostTimer);
      this.lostTimer = null;
    } else if (!this.lostTimer) {
      this.lostTimer = setTimeout(() => this.emit("lost"), LOST_AFTER_MS);
      this.lostTimer.unref();
    }
    if (this.connected === on) return;
    this.connected = on;
    this.emit("link", on);
    // back after a drop: make sure the TV is on the current song
    if (on && this.current && !this.current.started) void this.sendCurrent();
  }

  // ---------- events from the TV ----------

  private consume(events: [number, unknown[]][]) {
    for (const [idx, ev] of events) {
      if (typeof idx === "number" && idx > this.aid) this.aid = idx;
      const [name, data] = ev as [string, any];
      this.emit("raw", name, data);
      if (castLog.verbose && !["noop", "c", "S", "onVideoQualityChanged", "onAudioTrackChanged", "onHasPreviousNextChanged", "autoplayUpNext", "onAutoplayModeChanged", "onVolumeChanged", "onSubtitlesTrackChanged"].includes(name)) console.log(`lounge[${this.name}] event #${idx} ${name} ${JSON.stringify(data)?.slice(0, 300)}`);
      switch (name) {
        case "c":
          this.sid = String(data);
          break;
        case "S":
          this.gsid = String(data);
          break;
        case "loungeStatus":
          this.setLink(true);
          break;
        case "loungeScreenDisconnected":
          this.setLink(false);
          break;
        case "nowPlaying":
        case "onStateChange":
          this.onState(name, data ?? {});
          break;
      }
    }
  }

  /**
   * What the TV is playing. Three cases:
   *  - our song (sent with play()): progress, remote pause/play, ended, or idle;
   *  - another video the TV started by itself (someone used the TV remote): tracked as
   *    `ext` and reported with "external", so the room can show it as the current video;
   *  - nothing (the TV went back to its home screen): "idle", after a short debounce.
   */
  private onState(name: string, d: Record<string, string>) {
    if (name === "nowPlaying") this.tvVideoId = d.videoId ? String(d.videoId) : "";
    const cur = this.current;
    const vid = this.tvVideoId;
    const state = Number(d.state);
    const hasState = Number.isFinite(state);
    const time = Number(d.currentTime);
    const duration = Number(d.duration);

    // "nowPlaying" without a video: the TV is idle (home screen)
    if (name === "nowPlaying" && !vid) {
      if (cur?.started || this.ext) this.scheduleIdle();
      return;
    }
    if (!vid) return;

    const ours = !!cur && vid === cur.item.videoId;
    if (!ours) {
      // the TV is still switching to the song we just sent: events are about the old video
      if (cur && !cur.started && Date.now() - cur.sentAt < SWITCH_GRACE_MS) return;
      if (hasState && (state === 0 || state === -1)) {
        // the other video ended / stopped
        if (this.ext?.videoId === vid) {
          if (state === 0) this.stopped(true, this.ext);
          else this.scheduleIdle();
        }
        return;
      }
      if (!this.ext || this.ext.videoId !== vid) {
        // someone started a different video on the TV: it takes over from our song
        const interrupted = cur?.started ? cur.item.id : null;
        if (cur) this.finish();
        this.ext = { videoId: vid, started: false, time: 0, duration: 0 };
        console.log(`lounge[${this.name}] TV is playing another video: ${vid}`);
        this.emit("external", vid, interrupted);
      }
    } else if (this.ext) {
      this.ext = null; // back on our song
    }
    const t = (ours ? cur : this.ext)!;
    if (Number.isFinite(time)) t.time = time;
    if (Number.isFinite(duration) && duration > 0) t.duration = duration;
    const id = ours ? cur!.item.id : "external";

    // The TV's periodic "nowPlaying" updates carry the position but no state: they keep
    // the progress bar moving (the phones only interpolate for a few seconds).
    if (!hasState) {
      if (t.started && Number.isFinite(time)) this.emitProgress(id, t.time, t.duration);
      return;
    }
    if (state === 1 || state === 2 || state === 3) {
      this.cancelIdle();
      if (!t.started && state === 1) {
        t.started = true;
        if (ours) {
          if (cur!.watchdog) clearTimeout(cur!.watchdog);
          if (cur!.pauseOnStart) void this.send("pause").catch(() => {});
        }
      } else if (t.started && state !== 3) {
        this.remoteState(state === 1);
      }
      if (t.started) this.emitProgress(id, t.time, t.duration);
    } else if (state === 0) {
      if (t.started) this.stopped(true, ours ? cur! : this.ext!);
    } else if (state === -1 && t.started) {
      this.scheduleIdle(); // maybe just a hiccup between states; see scheduleIdle
    }
  }

  /** A video finished (`ended`) or the TV left it; ours or the external one. */
  private stopped(ended: boolean, t: Current | Ext) {
    this.cancelIdle();
    if ("item" in t) {
      const id = t.item.id;
      this.finish();
      if (ended) this.emit("ended", id);
      else this.emit("idle", id);
    } else {
      this.ext = null;
      this.emit(ended ? "external-ended" : "external-idle");
    }
  }

  /**
   * The TV reported "stopped" or an empty nowPlaying. It also does that for a moment
   * between states, so only treat it as the TV having left the video if nothing plays
   * again within a few seconds. The room decides whether the song had actually ended.
   */
  private scheduleIdle() {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.current?.started) this.stopped(false, this.current);
      else if (this.ext) this.stopped(false, this.ext);
    }, IDLE_AFTER_MS);
    this.idleTimer.unref();
  }

  private cancelIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private finish() {
    if (this.current?.watchdog) clearTimeout(this.current.watchdog);
    this.current = null;
  }

  // ---------- PlaybackOutput ----------

  private async sendCurrent() {
    const cur = this.current;
    if (!cur) return;
    try {
      // pyytlounge sends just the videoId; add the position only when resuming mid-song
      await this.send("setPlaylist", {
        videoId: cur.item.videoId,
        ...(cur.startAt > 0 ? { currentTime: String(Math.floor(cur.startAt)), currentIndex: "-1" } : {}),
      });
      cur.sent = true;
      cur.sentAt = Date.now();
      cur.watchdog && clearTimeout(cur.watchdog);
      cur.watchdog = setTimeout(() => {
        if (this.current === cur && !cur.started) {
          this.finish();
          this.emit("error", cur.item.id);
        }
      }, START_TIMEOUT_MS);
      cur.watchdog.unref();
    } catch (err) {
      // not connected / session died: the listener rebinds and setLink() resends
      console.warn(`lounge: couldn't send "${cur.item.title}" yet: ${(err as Error).message}`);
    }
  }

  async play(item: QueueItem, opts: PlayOptions = {}): Promise<void> {
    this.finish();
    this.settle();
    this.clearSeek();
    this.ext = null;
    this.cancelIdle();
    this.tvVideoId = "";
    this.current = { item, started: false, startAt: opts.startAt ?? 0, pauseOnStart: !!opts.paused, sent: false, sentAt: Date.now(), time: opts.startAt ?? 0, duration: 0 };
    await this.sendCurrent();
  }
  /** Ask the TV what it is playing (also picks up a video that was already running). */
  async syncNow() {
    await this.send("getNowPlaying").catch(() => {});
  }
  async pause() {
    this.expectState(false);
    await this.send("pause").catch(() => this.settle());
  }
  async resume() {
    this.expectState(true);
    await this.send("play").catch(() => this.settle());
  }

  // A pause/resume takes a moment to reach the TV. Until it confirms, state reports that still
  // show the old state are stale: ignore them, or the room flips back and then forward again.
  private expect: { playing: boolean; at: number; timer: NodeJS.Timeout } | null = null;
  private expectState(playing: boolean) {
    if (this.expect) clearTimeout(this.expect.timer);
    const timer = setTimeout(() => {
      console.warn(`lounge[${this.name}] the TV didn't confirm ${playing ? "play" : "pause"} in ${PENDING_MS}ms; re-reading its state`);
      this.settle();
      void this.syncNow();
    }, PENDING_MS);
    timer.unref();
    this.expect = { playing, at: Date.now(), timer };
  }
  private settle() {
    if (!this.expect) return;
    clearTimeout(this.expect.timer);
    this.expect = null;
    this.emit("settled");
  }
  private remoteState(playing: boolean) {
    const e = this.expect;
    if (!e) return void this.emit("remote-state", playing ? "playing" : "paused");
    if (playing !== e.playing) return; // from before our command landed
    console.log(`lounge[${this.name}] TV confirmed ${playing ? "play" : "pause"} after ${Date.now() - e.at}ms`);
    this.settle();
  }
  async seek(seconds: number) {
    const target = Math.max(0, Math.floor(seconds));
    this.expectSeek(target);
    await this.send("seekTo", { newTime: String(target) }).catch(() => this.clearSeek());
  }

  // Same idea as pause/resume: until the TV reports a position near the seek target, its
  // reports are from before the jump and would pull the progress bar back.
  private seekExpect: { target: number; at: number; timer: NodeJS.Timeout } | null = null;
  private expectSeek(target: number) {
    this.clearSeek();
    const timer = setTimeout(() => (this.seekExpect = null), PENDING_MS);
    timer.unref();
    this.seekExpect = { target, at: Date.now(), timer };
  }
  private clearSeek() {
    if (this.seekExpect) clearTimeout(this.seekExpect.timer);
    this.seekExpect = null;
  }
  private emitProgress(itemId: string, time: number, duration: number) {
    const s = this.seekExpect;
    if (s) {
      // near the target, or near where playing on from it would be by now (a paused video stays put)
      const ahead = s.target + (Date.now() - s.at) / 1000;
      if (Math.min(Math.abs(time - s.target), Math.abs(time - ahead)) > 4) return;
      console.log(`lounge[${this.name}] TV confirmed seek after ${Date.now() - s.at}ms`);
      this.clearSeek();
    }
    this.emit("progress", { itemId, time, duration });
  }
  async stop() {
    this.finish();
    this.ext = null;
    this.cancelIdle();
    await this.send("stopVideo").catch(() => {});
  }
  async dispose() {
    this.closed = true;
    this.finish();
    if (this.lostTimer) clearTimeout(this.lostTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.expect) clearTimeout(this.expect.timer);
    this.expect = null;
    this.clearSeek();
    this.cancelIdle();
    this.abort.abort();
    this.connected = false;
    this.removeAllListeners();
  }
}
