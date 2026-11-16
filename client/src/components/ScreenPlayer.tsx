import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { QueueItem, RoomState, ScreenCommand } from "@karaoke/shared";
import { qrSrc, useJoinUrl } from "../lib/joinUrl.ts";
import { connect, type KSocket } from "../lib/socket.ts";
import Scrubber from "./Scrubber.tsx";
import { moveOffIpAddress } from "../lib/hostRedirect.ts";

// Minimal typings for the YouTube IFrame Player API.
interface YTPlayer {
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void;
  cueVideoById(opts: { videoId: string; startSeconds?: number }): void;
  getPlayerState(): number; // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: object) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    }
  });
}

/** Playback controls for the fullscreen bar. They go through the room (permission-checked). */
export interface PlayerControls {
  paused: boolean;
  canControl: boolean; // seek + back
  canSkip: boolean;
  canGoBack: boolean; // a previous song exists
  onTogglePause: () => void;
  onSkip: () => void;
  onRewind: () => void;
  onSeek: (seconds: number) => void;
}
export interface PlayerHandle {
  takeBack: () => void;
}
const RESTART_AFTER = 5; // ⏮ restarts the song after this many seconds (matches the server)
const HIDE_AFTER = 3000; // fullscreen controls fade after this long without input

/** Browsers only allow sound after the user has interacted with the page. */
const hasUserActivation = () => (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? false;

/**
 * The room's playback output. Joins as the room's (single) screen and plays
 * whatever the server says.
 *  - variant "screen": full-screen display with QR, up-next and a seek bar
 *  - variant "embedded": compact 16:9 player inside the host's room page
 */
export default function ScreenPlayer({
  code,
  variant,
  deviceId,
  autoFull = false,
  controls,
  onReplacedChange,
  handle,
}: {
  code: string;
  variant: "screen" | "embedded";
  deviceId?: string; // the room-page identity of this device (gets host powers while it's the screen)
  autoFull?: boolean; // open straight into full screen (screen mode)
  controls?: PlayerControls;
  /** When given, the parent shows its own "another screen took over" message. */
  onReplacedChange?: (replaced: boolean) => void;
  handle?: MutableRefObject<PlayerHandle | null>;
}) {
  const isScreen = variant === "screen";
  const joinUrl = useJoinUrl(code);
  const [started, setStarted] = useState(hasUserActivation);
  const startedRef = useRef(started); // sound allowed (the user has clicked)
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const [showIntro, setShowIntro] = useState(false);
  const [replaced, setReplaced] = useState(false);
  const [session, setSession] = useState(0); // bump to (re)join as the screen
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [blocked, setBlocked] = useState(false); // browser refused to autoplay
  const [full, setFull] = useState(autoFull);
  // YouTube blocks the current video at this page's raw-IP address (it plays fine by hostname)
  const [ipBlocked, setIpBlocked] = useState<{ itemId: string; shareHost: string | null; reason: "ip" | "device" } | null>(null);
  const [reopenFailed, setReopenFailed] = useState(false); // embedded player shown full screen
  const rootEl = useRef<HTMLDivElement>(null);
  const target = useRef<{ itemId: string; startAt: number } | null>(null); // where playback should begin
  const shouldPlay = useRef(false);

  const playerEl = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const ready = useRef(false);
  const currentRef = useRef<QueueItem | null>(null);
  const pending = useRef<ScreenCommand | null>(null);
  const socket = useRef<KSocket | null>(null);

  function apply(cmd: ScreenCommand) {
    if (!ready.current || !player.current) {
      // remember the latest play/stop; pause/resume only matter after a play
      if (cmd.action === "play" || cmd.action === "stop") pending.current = cmd;
      return;
    }
    const p = player.current;
    switch (cmd.action) {
      case "play": {
        if (currentRef.current?.id === cmd.item.id) return;
        setIpBlocked(null);
        currentRef.current = cmd.item;
        setCurrent(cmd.item);
        const startSeconds = Math.max(0, Math.floor(cmd.startAt ?? 0));
        // Only announce the singer at the start of a song, not when resuming mid-song.
        setShowIntro(startSeconds < 3);
        const opts = { videoId: cmd.item.videoId, startSeconds };
        target.current = { itemId: cmd.item.id, startAt: cmd.startAt ?? 0 };
        shouldPlay.current = !cmd.paused;
        setBlocked(false);
        // Before the first click, only cue it: the click then presses play while it
        // still counts as a user gesture (a load started later may be refused).
        if (cmd.paused || !startedRef.current) p.cueVideoById(opts);
        else p.loadVideoById(opts);
        if (!cmd.paused && startedRef.current) verifyStarted(cmd.item.id);
        break;
      }
      case "pause":
        shouldPlay.current = false;
        setBlocked(false);
        p.pauseVideo();
        break;
      case "resume":
        shouldPlay.current = true;
        p.playVideo();
        if (currentRef.current) verifyStarted(currentRef.current.id);
        break;
      case "seek":
        if (target.current) target.current = null; // an explicit seek wins over the resume point
        p.seekTo(cmd.seconds, true);
        break;
      case "stop":
        setIpBlocked(null);
        currentRef.current = null;
        target.current = null;
        shouldPlay.current = false;
        setBlocked(false);
        setCurrent(null);
        p.stopVideo();
        break;
    }
  }

  /**
   * Make sure a song that should play actually starts: nudge it once, and if the
   * browser still refuses (phones especially want a fresh tap), ask for a tap.
   */
  function verifyStarted(itemId: string, attempt = 0) {
    setTimeout(
      () => {
        const p = player.current;
        if (!p || currentRef.current?.id !== itemId || !shouldPlay.current) return;
        const st = p.getPlayerState?.();
        if (st !== -1 && st !== 5 && st !== 2) return; // playing or buffering: fine
        if (attempt === 0) {
          // A video loaded into a player that sat idle sometimes stays "unstarted"
          // even though autoplay is allowed; a plain play() starts it.
          p.playVideo();
          verifyStarted(itemId, 1);
        } else setBlocked(true); // the browser really wants a tap
      },
      attempt === 0 ? 1500 : 2500,
    );
  }

  /** The user's tap: start playback from where the room is, inside the gesture. */
  function tapToPlay() {
    const p = player.current;
    setBlocked(false);
    setStarted(true);
    startedRef.current = true;
    if (!p || !ready.current || !currentRef.current || !shouldPlay.current) return;
    const t = target.current;
    if (t && currentRef.current?.id === t.itemId && t.startAt > 1) p.seekTo(t.startAt, true);
    p.playVideo();
    if (currentRef.current) verifyStarted(currentRef.current.id);
  }

  // Socket: join as the room's screen. A newer screen elsewhere replaces us.
  useEffect(() => {
    const s = connect();
    socket.current = s;
    let replacedHere = false;
    // (re)joins on every connect — but never after being replaced: a reconnect
    // would silently steal playback back from the screen that took over.
    s.on("connect", () => {
      if (replacedHere) return;
      s.emit("screen:join", { code, deviceId, host: window.location.hostname }, (r) => {
        if (!r.ok) return setError(r.error);
        setState(r.state);
      });
    });
    s.on("room:state", setState);
    s.on("screen:command", apply);
    s.on("screen:blocked", (b) => {
      shouldPlay.current = false; // don't also ask for a "tap to play"
      setBlocked(false);
      setReopenFailed(false);
      setIpBlocked(b);
    });
    s.on("screen:replaced", () => {
      replacedHere = true;
      s.disconnect(); // our side closes it, so socket.io won't auto-reconnect
      setReplaced(true);
      currentRef.current = null;
      setCurrent(null);
      try {
        player.current?.stopVideo();
      } catch {
        /* player not created yet */
      }
    });
    return () => {
      s.disconnect();
    };
  }, [code, session]);

  // Create the player (hidden behind the start overlay until the first click).
  useEffect(() => {
    let cancelled = false;
    loadYouTubeApi().then(() => {
      if (cancelled || !playerEl.current) return;
      player.current = new window.YT!.Player(playerEl.current, {
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, origin: window.location.origin },
        events: {
          onReady: () => {
            if (import.meta.env.DEV) (window as unknown as { __kplayer: unknown }).__kplayer = player.current; // test hook
            ready.current = true;
            const cmd = pending.current;
            pending.current = null;
            if (cmd) apply(cmd);
          },
          onStateChange: (e: { data: number }) => {
            const item = currentRef.current;
            if (e.data === 1) {
              setBlocked(false);
              // Some players ignore startSeconds: jump to where the room actually is.
              const t = target.current;
              if (t && item?.id === t.itemId) {
                target.current = null;
                const now = player.current?.getCurrentTime() ?? 0;
                if (Math.abs(now - t.startAt) > 2) player.current?.seekTo(t.startAt, true);
              }
            }
            if (item && e.data === 0) socket.current?.emit("screen:event", { type: "ended", itemId: item.id });
          },
          onError: (e: { data: number }) => {
            const item = currentRef.current;
            if (item) socket.current?.emit("screen:event", { type: "error", itemId: item.id, errorCode: e.data });
          },
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, []); // created right away (hidden) so the first click can start playback itself

  // Poll the player; report position ~1/s so phones can show and control it.
  useEffect(() => {
    if (!current) return;
    setTime(0);
    setDuration(0);
    let tick = 0;
    const id = setInterval(() => {
      const p = player.current;
      if (!p?.getCurrentTime) return;
      const t = p.getCurrentTime() || 0;
      const d = p.getDuration() || 0;
      setTime(t);
      setDuration(d);
      // Only real playback (1 playing, 2 paused): a cued/loading video would report 0:00.
      const st = p.getPlayerState?.();
      if (++tick % 4 === 0 && (st === 1 || st === 2)) socket.current?.emit("screen:progress", { itemId: current.id, time: t, duration: d });
    }, 250);
    return () => clearInterval(id);
  }, [current?.id]);

  const seek = (to: number) => {
    if (!current) return;
    player.current?.seekTo(to, true);
    setTime(to);
    socket.current?.emit("screen:progress", { itemId: current.id, time: to, duration });
  };

  useEffect(() => {
    if (!showIntro) return;
    const t = setTimeout(() => setShowIntro(false), 7000);
    return () => clearTimeout(t);
  }, [showIntro, current?.id]);

  const takeBack = () => {
    setReplaced(false);
    setSession((n) => n + 1);
    if (autoFull) {
      // screen mode: back to full screen (still inside the click, so the browser allows it)
      setFull(true);
      setTimeout(() => void enterNativeFull(), 50);
    }
  };
  if (handle) handle.current = { takeBack };
  useEffect(() => {
    onReplacedChange?.(replaced);
    if (!replaced) return;
    // Leave full screen: the player is hidden now, and a fullscreen hidden element
    // would leave a black overlay covering the page.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setFull(false);
  }, [replaced]);

  // ----- fullscreen control bar: shows on any input, fades after HIDE_AFTER -----
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const timeRef = useRef(0);
  timeRef.current = time;
  const [active, setActive] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const poke = () => {
    setActive(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setActive(false), HIDE_AFTER);
  };
  const fsBar = full && !!controls && !!current; // YouTube-style bar while a song plays full screen
  const uiVisible = active || !!controls?.paused;

  const seekVia = (to: number) => {
    const c = controlsRef.current;
    if (!c?.canControl) return;
    player.current?.seekTo(to, true); // feels instant; the room confirms it
    setTime(to);
    c.onSeek(to);
  };

  useEffect(() => {
    if (!fsBar) return;
    poke();
    const onKey = (e: KeyboardEvent) => {
      const c = controlsRef.current;
      if (!c) return;
      poke();
      const d = duration;
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") c.onTogglePause();
      else if ((k === "arrowright" || k === "l") && d) seekVia(Math.min(d - 0.5, timeRef.current + 10));
      else if ((k === "arrowleft" || k === "j") && d) seekVia(Math.max(0, timeRef.current - 10));
      else if (k === "n" && e.shiftKey && c.canSkip) c.onSkip();
      else if (k === "p" && e.shiftKey && c.canControl) c.onRewind();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointermove", poke);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointermove", poke);
      clearTimeout(hideTimer.current);
    };
  }, [fsBar, duration]);

  /** Tap/click on the video: touch shows the controls first; otherwise toggles pause (like YouTube). */
  const onVideoPointer = (e: React.PointerEvent) => {
    if (!fsBar || !startedRef.current) return;
    const wasVisible = uiVisible;
    poke();
    if (e.pointerType === "touch" && !wasVisible) return;
    controlsRef.current?.onTogglePause();
  };

  if (error) return isScreen ? <main className="screen-msg">{error}</main> : <div className="embed-note error">{error}</div>;

  // Note: the player stays mounted while replaced; unmounting it would kill the
  // YouTube iframe and "take it back" would then have nothing to play on.
  const replacedNote = replaced &&
    (isScreen ? (
      <main className="screen-msg replaced">
        <div className="stack center" style={{ maxWidth: 520 }}>
          <div className="orb" aria-hidden="true" />
          <h2>This screen was replaced</h2>
          <p className="muted">Room {code} is now playing on another display. Only one screen can play at a time.</p>
          <button className="btn primary big" onClick={takeBack}>
            Use this screen instead
          </button>
        </div>
      </main>
    ) : (
      <div className="embed-note">
        <span className="muted">Playing on another screen.</span>
        <button className="btn small" onClick={takeBack}>
          Play here instead
        </button>
      </div>
    ));

  const enterNativeFull = async () => {
    const el = rootEl.current;
    if (!el?.requestFullscreen || document.fullscreenElement) return;
    await el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape").catch(() => {});
  };
  // Screen mode: go full screen right away. Real fullscreen needs a recent click
  // (e.g. the landing page's Create/Join); otherwise the CSS version fills the window.
  useEffect(() => {
    if (autoFull) void enterNativeFull();
  }, []);

  const toggleFull = async () => {
    if (full) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setFull(false);
      return;
    }
    setFull(true); // CSS full-viewport fallback (iPhone has no element fullscreen)
    await enterNativeFull();
  };
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  const big = isScreen || full; // screen-style overlays

  const upNext = state?.queue.slice(0, 5) ?? [];
  const playing = !!current;

  return (
    <>
    {!isScreen && !onReplacedChange && replacedNote}
    <div ref={rootEl} className={isScreen ? "screen" : `embed${full ? " full" : ""}${fsBar && !uiVisible ? " ui-hidden" : ""}`} hidden={!isScreen && replaced}>
      {isScreen && replacedNote}
      <div className={`player ${playing ? "" : "hidden"}`}>
        <div ref={playerEl} />
      </div>

      {!started && (
        <button
          className="start-overlay"
          onClick={() => {
            tapToPlay(); // marks sound as allowed and, if a song is waiting, plays it inside this click
            if (full) void enterNativeFull();
          }}
        >
          <div className="orb" aria-hidden="true" />
          <div className="start-title">{big ? "Click to start the karaoke screen" : "Tap to play here"}</div>
          <div className="muted">Browsers need one click before they'll play sound.</div>
        </button>
      )}

      {started && !playing &&
        (big ? (
          <div className="idle">
            <div className="idle-join">
              <img className="qr big" src={qrSrc(joinUrl)} alt="Scan to join" />
              <div>
                <div className="idle-title">Scan to queue a song</div>
                <div className="big-code">{code}</div>
                <div className="muted">{joinUrl}</div>
              </div>
            </div>
            {upNext.length > 0 ? <UpNext items={upNext} /> : <p className="muted">The queue is empty. Add a song from your phone.</p>}
          </div>
        ) : (
          <div className="embed-idle muted">Songs play here. Queue one below.</div>
        ))}

      {playing && (
        <>
          {big && (
            <div className="corner-join">
              <img className="qr" src={qrSrc(joinUrl)} alt="" />
              <div className="small">
                Join: <b>{code}</b>
              </div>
            </div>
          )}
          {showIntro && current && (
            <div className="intro">
              <div className="eyebrow">Now singing</div>
              <div className="intro-singer">{current.singerName}</div>
              <div className="intro-title">{current.title}</div>
            </div>
          )}
          {big && upNext[0] && !(fsBar && uiVisible) && (
            <div className="next-ticker">
              Up next: <b>{upNext[0].singerName}</b> · {upNext[0].title}
            </div>
          )}
          {state?.paused && <div className="paused-badge">Paused</div>}
          {big && !fsBar && <ScreenSeekBar time={time} duration={duration} paused={!!state?.paused} onSeek={seek} />}
          {/* catches pointer input over the iframe (which would otherwise swallow it) */}
          <div className="seek-catcher" onPointerUp={onVideoPointer} />
          {fsBar && controls && (
            <FullControls
              c={controls}
              time={time}
              duration={duration}
              visible={uiVisible}
              onSeek={seekVia}
              onActivity={poke}
              onExit={toggleFull}
            />
          )}
        </>
      )}

      {ipBlocked && (
        <div className="start-overlay ip-blocked" role="alert">
          {ipBlocked.reason === "device" ? (
            <>
              <div className="start-title">YouTube won't play this video on this device</div>
              <div className="muted">
                If another device was playing it, tap "play here instead" there to keep singing. Otherwise skip the song.
              </div>
            </>
          ) : (
            <>
              <div className="start-title">YouTube blocks this video at this address</div>
              <div className="muted">
                This screen is open at {window.location.host}, an address where YouTube blocks many videos. Opened by name, the same video plays, and the song continues where
                it stopped.
              </div>
            </>
          )}
          <div className="row">
            {ipBlocked.reason === "ip" && ipBlocked.shareHost && (
              <button
                className="btn primary"
                onClick={async () => {
                  if (!(await moveOffIpAddress())) setReopenFailed(true);
                }}
              >
                Reopen at {ipBlocked.shareHost}
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                socket.current?.emit("screen:event", { type: "skip-blocked", itemId: ipBlocked.itemId });
                setIpBlocked(null);
              }}
            >
              Skip song
            </button>
          </div>
          {reopenFailed && (
            <p className="error small">This device can't reach {ipBlocked.shareHost}. Skip the song, or ask the host to set KARAOKE_HOST.</p>
          )}
        </div>
      )}

      {blocked && started && (
        <button className="start-overlay tap-play" onClick={tapToPlay}>
          <span className="tap-icon" aria-hidden="true">▶</span>
          <span className="start-title">Tap to play</span>
          <span className="muted">This browser needs a tap before it plays sound.</span>
        </button>
      )}

      {!isScreen && started && !fsBar && (
        <button className="full-btn" onClick={toggleFull} aria-label={full ? "Exit full screen" : "Full screen"}>
          {full ? "✕" : "⛶"}
        </button>
      )}
    </div>
    </>
  );
}

/** Fullscreen toolbar: seek bar on top, transport buttons below (YouTube-style). */
function FullControls({
  c,
  time,
  duration,
  visible,
  onSeek,
  onActivity,
  onExit,
}: {
  c: PlayerControls;
  time: number;
  duration: number;
  visible: boolean;
  onSeek: (t: number) => void;
  onActivity: () => void;
  onExit: () => void;
}) {
  const backEnabled = c.canControl && (c.canGoBack || time >= RESTART_AFTER);
  return (
    <div className={`fs-controls ${visible ? "" : "faded"}`} onPointerDown={onActivity} onPointerMove={onActivity}>
      <Scrubber className="fs-scrub" time={time} duration={duration} onSeek={onSeek} onActivity={onActivity} readOnly={!c.canControl} />
      <div className="fs-row">
        <button
          className="fs-btn"
          disabled={!backEnabled}
          onClick={c.onRewind}
          aria-label={time >= RESTART_AFTER ? "Restart song" : "Previous song"}
          title={time >= RESTART_AFTER ? "Restart (Shift+P)" : "Previous song (Shift+P)"}
        >
          ⏮
        </button>
        <button className="fs-btn play" onClick={c.onTogglePause} aria-label={c.paused ? "Play" : "Pause"} title={`${c.paused ? "Play" : "Pause"} (Space)`}>
          {c.paused ? "▶" : "❚❚"}
        </button>
        <button className="fs-btn" disabled={!c.canSkip} onClick={c.onSkip} aria-label="Skip" title="Skip (Shift+N)">
          ⏭
        </button>
        <span className="fs-spacer" />
        <button className="fs-btn" onClick={onExit} aria-label="Exit full screen" title="Exit full screen (Esc)">
          ✕
        </button>
      </div>
    </div>
  );
}

/** Screen seek bar: auto-hides while playing; ←/→ (remotes) jump 10 seconds. */
function ScreenSeekBar({ time, duration, paused, onSeek }: { time: number; duration: number; paused: boolean; onSeek: (t: number) => void }) {
  const [visible, setVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const poke = () => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 3000);
  };

  useEffect(() => {
    poke();
    return () => clearTimeout(hideTimer.current);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      poke();
      if (!duration) return;
      if (e.key === "ArrowRight") onSeek(Math.min(duration - 0.5, time + 10));
      else if (e.key === "ArrowLeft") onSeek(Math.max(0, time - 10));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", poke);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", poke);
    };
  });

  return (
    <Scrubber
      className={`seekbar ${visible || paused ? "" : "faded"}`}
      time={time}
      duration={duration}
      onSeek={(t) => {
        onSeek(t);
        poke();
      }}
      onActivity={poke}
    />
  );
}

function UpNext({ items }: { items: QueueItem[] }) {
  return (
    <div className="upnext">
      <h3>Up next</h3>
      <ol>
        {items.map((q) => (
          <li key={q.id}>
            <b>{q.singerName}</b> <span className="muted">— {q.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
