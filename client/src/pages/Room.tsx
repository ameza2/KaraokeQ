import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { THEMES, THEME_LABELS, type QueueItem, type RoomState, type Singer, type ThemeName } from "@karaoke/shared";
import { useTheme } from "../lib/theme.ts";
import Scrubber from "../components/Scrubber.tsx";
import Search from "./Search.tsx";
import ScreenPlayer, { takenOverText, type PlayerHandle, type ReplacedBy } from "../components/ScreenPlayer.tsx";
import { qrSrc, useJoinUrl, useLanHost } from "../lib/joinUrl.ts";
import { getName, isPlayerDevice, setLastScreenRoom, setName as saveName, setPlayerDevice } from "../lib/storage.ts";
import { useRoom, type TimedProgress, type Toast } from "../lib/useRoom.ts";

const SCREEN_NAME = "Screen";

/** /r/:code (a person) or /r/:code/screen (the room's screen device). */
export default function Room({ screenMode = false }: { screenMode?: boolean }) {
  const code = useParams().code!.toUpperCase();
  const [name, setName] = useState<string | null>(getName() || null);
  useEffect(() => {
    if (screenMode) setLastScreenRoom(code);
  }, [screenMode, code]);

  if (screenMode) return <RoomView code={code} name={SCREEN_NAME} screenMode onRename={() => {}} />;

  if (!name)
    return (
      <NameForm
        code={code}
        onDone={(n) => {
          saveName(n);
          setName(n);
        }}
      />
    );
  return <RoomView code={code} name={name} onRename={(n) => (saveName(n), setName(n))} />;
}

function NameForm({ code, onDone, initial = "" }: { code: string; onDone: (n: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <main className="home">
      <div className="orb" aria-hidden="true" />
      <h1>Room {code}</h1>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onDone(value.trim().slice(0, 24));
        }}
      >
        <label className="muted">What should we call you?</label>
        <input className="input" autoFocus maxLength={24} placeholder="Your name" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn primary big" disabled={!value.trim()}>
          Join the party
        </button>
      </form>
    </main>
  );
}

function RoomView({ code, name, onRename, screenMode = false }: { code: string; name: string; onRename: (n: string) => void; screenMode?: boolean }) {
  const { me, state, isHost, isScreenDevice, hostPowers, canControl, error, connected, toasts, toast, progress, setProgress, socket } = useRoom(code, name, screenMode);
  useTheme(state?.settings.theme, `room:${code}`); // the room's colour preset, chosen by its host
  const [tab, setTab] = useState<"search" | "queue">("search");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [playHere, setPlayHere] = useState(() => screenMode || isPlayerDevice(code));
  const lanHost = useLanHost();
  const [screenReplacedBy, setScreenReplacedBy] = useState<ReplacedBy | null>(null); // what took playback from this device
  const screenReplaced = screenReplacedBy !== null;
  const playerHandle = useRef<PlayerHandle | null>(null);
  const togglePlayHere = (on: boolean) => {
    setPlayerDevice(code, on);
    setPlayHere(on);
  };
  // hooks must run before the early returns below
  const playback = usePlaybackTime(progress, state?.nowPlaying?.id, !!state?.paused);

  if (error)
    return (
      <main className="home">
        <div className="orb" aria-hidden="true" />
        <p className="error">{error}</p>
        <Link className="btn" to="/">
          Back home
        </Link>
      </main>
    );
  if (!state) return <main className="home muted">Connecting…</main>;

  const s = socket.current!;
  const mine = state.queue.filter((q) => q.singerId === me).length;
  const myNext = state.queue.findIndex((q) => q.singerId === me);
  const queuedIds = new Set(state.queue.map((q) => q.videoId).concat(state.nowPlaying?.videoId ?? []));

  const rename = () => setSheet("rename");
  const seekTo = (seconds: number) => {
    // optimistic: move the bar now, the screen's next report confirms it
    if (progress) setProgress({ ...progress, time: seconds, at: performance.now() });
    s.emit("playback:seek", { seconds });
  };
  const screenUrl = `${location.protocol}//${lanHost}/r/${code}/screen`;
  const currentHost = state.singers.find((x) => x.id === state.hostId) ?? null;
  const casting = state.mode === "lounge";
  const showScreenHelp = (!casting && isHost && !playHere && state.screens === 0) || (playHere && screenReplaced);
  const applyName = (n: string) => {
    setSheet(null);
    if (n === name) return;
    onRename(n);
    s.emit("singer:rename", { name: n });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="room-code">
            Room <b>{code}</b>{" "}
            {screenMode ? (
              <span className="pill">Screen</span>
            ) : isHost ? (
              <span className="pill">Host</span>
            ) : (
              hostPowers && <span className="pill" title="This device is playing the videos, so it keeps host controls">Screen</span>
            )}
            {!connected && <span className="pill warn">Reconnecting…</span>}
          </div>
          {screenMode ? (
            <span className="muted small">{hostPowers ? "This screen has host controls" : "Not the active screen"}</span>
          ) : (
            <button className="link muted small" onClick={rename}>
              Singing as {name} ✎
            </button>
          )}
        </div>
        <div className="row">
          <button className="btn small" onClick={() => setSheet("share")}>
            Invite
          </button>
          <button className="icon-btn" onClick={() => setSheet("menu")} aria-label="Menu" aria-haspopup="menu">
            ☰
          </button>
        </div>
      </header>

      {playHere && (
        <ScreenPlayer
          code={code}
          variant="embedded"
          deviceId={me}
          autoFull={screenMode}
          handle={playerHandle}
          onReplacedChange={(replaced, by) => setScreenReplacedBy(replaced ? by : null)}
          controls={{
            paused: state.paused,
            canControl,
            canSkip: canControl || state.nowPlaying?.singerId === me,
            canGoBack: state.canGoBack,
            onTogglePause: () => s.emit(state.paused ? "playback:resume" : "playback:pause"),
            onSkip: () => s.emit("playback:skip"),
            onRewind: () => s.emit("playback:rewind"),
            onSeek: seekTo,
          }}
        />
      )}

      <NowPlaying
        item={state.nowPlaying}
        paused={state.paused}
        pending={state.pausePending}
        isHost={canControl}
        canSkip={canControl || state.nowPlaying?.singerId === me}
        time={playback.time}
        canGoBack={state.canGoBack}
        queueLength={state.queue.length}
        onStart={() => s.emit("playback:resume")}
        onSkip={() => s.emit("playback:skip")}
        onPause={() => s.emit(state.paused ? "playback:resume" : "playback:pause")}
        onRewind={() => s.emit("playback:rewind")}
      />
      {canControl && state.nowPlaying && (
        <HostSeek
          time={playback.time}
          duration={playback.duration}
          known={playback.known}
          noScreen={!casting && state.screens === 0}
          onSeek={seekTo}
        />
      )}

      {state.hostClaimable && !hostPowers && (
        <div className="banner">
          The host has been away for over 5 minutes, so nobody can change settings or hand the room over.{" "}
          <button
            className="link inline"
            onClick={() =>
              s.emit("host:claim", (r) => {
                if (!r.ok) toast({ level: "error", message: r.error });
              })
            }
          >
            Claim host
          </button>
        </div>
      )}
      {casting && state.cast && !state.cast.connected && (
        <div className="banner">
          The YouTube cast lost its connection to {state.cast.name}. It keeps trying, and the TV keeps playing its current video.
          {hostPowers && (
            <>
              {" "}
              To keep going now, open{" "}
              <a href={screenUrl} target="_blank" rel="noreferrer">
                <b>{lanHost}/r/{code}/screen</b>
              </a>{" "}
              on a screen (this stops the cast), or{" "}
              <button className="link inline" onClick={() => s.emit("cast:unpair")}>
                stop casting
              </button>
              .
            </>
          )}
        </div>
      )}
      {showScreenHelp && (
        <div className="banner">
          {screenReplacedBy ? takenOverText(screenReplacedBy) : "Nothing is playing the videos."} Open{" "}
          <a href={screenUrl} target="_blank" rel="noreferrer">
            <b>{lanHost}/r/{code}/screen</b>
          </a>{" "}
          on a screen, or{" "}
          <button className="link inline" onClick={() => (screenReplaced ? playerHandle.current?.takeBack() : togglePlayHere(true))}>
            {screenReplaced ? "play here instead" : "play on this device"}
          </button>
          .
        </div>
      )}
      {myNext >= 0 && (
        <div className="banner subtle">
          {myNext === 0 ? "You're up next!" : `Your next song is #${myNext + 1} in line.`}
        </div>
      )}

      <nav className="tabs">
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>
          Search
        </button>
        <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>
          Queue ({state.queue.length})
        </button>
      </nav>

      {/* kept mounted so results and page survive tab switches */}
      <div hidden={tab !== "search"}>
        <Search
          code={code}
          mode={state.mode}
          queuedIds={queuedIds}
          mineCount={mine}
          onAdd={(video) =>
            new Promise<boolean>((resolve) =>
              s.emit("queue:add", { video }, (r) => {
                if (r.ok) toast({ level: "info", message: `Queued "${video.title}"` });
                else toast({ level: "error", message: r.error });
                resolve(r.ok);
              }),
            )
          }
        />
      </div>
      {tab === "queue" && (
        <Queue
          items={state.queue}
          me={me}
          isHost={canControl}
          onRemove={(id) => s.emit("queue:remove", { itemId: id })}
          onMove={(id, to) => s.emit("queue:move", { itemId: id, toIndex: to })}
        />
      )}

      {sheet === "menu" && (
        <MenuSheet
          isHost={hostPowers}
          screenMode={screenMode}
          code={code}
          screenUrl={screenUrl}
          historyCount={state.history.length}
          openControls={state.settings.openControls}
          onToggleOpenControls={() => s.emit("settings:update", { openControls: !state.settings.openControls })}
          fairQueue={state.settings.fairQueue}
          onToggleFairQueue={() => s.emit("settings:update", { fairQueue: !state.settings.fairQueue })}
          theme={state.settings.theme}
          onTheme={(theme) => s.emit("settings:update", { theme })}
          cast={state.cast}
          playHere={playHere}
          onTogglePlayHere={() => {
            togglePlayHere(!playHere);
            setSheet(null);
          }}
          onOpen={setSheet}
          onRename={rename}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "history" && (
        <HistorySheet
          items={state.history}
          queuedIds={new Set(state.queue.map((q) => q.videoId))}
          onReplay={(h) =>
            new Promise<void>((resolve) =>
              s.emit("history:replay", { itemId: h.id }, (r) => {
                if (r.ok) toast({ level: "info", message: `Added "${h.title}" to the end of the queue` });
                else toast({ level: "error", message: r.error });
                resolve();
              }),
            )
          }
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "share" && <ShareSheet code={code} isHost={hostPowers} onClose={() => setSheet(null)} />}
      {sheet === "host" && (
        <HostSheet
          singers={state.singers.filter((x) => x.id !== me && x.id !== state.hostId && !x.screen)}
          currentHost={currentHost}
          iAmHost={isHost}
          iAmScreen={isScreenDevice}
          onPick={(singer) =>
            s.emit("host:transfer", { singerId: singer.id }, (r) => {
              if (r.ok) {
                const from = currentHost && !isHost ? `from ${currentHost.name} ` : "";
                toast({ level: "info", message: from ? `Host moved ${from}to ${singer.name}` : `${singer.name} is now the host` });
                setSheet(null);
              } else toast({ level: "error", message: r.error });
            })
          }
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "cast" && (
        <CastSheet
          cast={state.cast}
          casting={casting}
          onPair={(linkCode) =>
            new Promise<boolean>((resolve) =>
              s.emit("cast:pair", { code: linkCode }, (r) => {
                if (r.ok) toast({ level: "info", message: `Playing on ${r.name}` });
                resolve(r.ok);
                if (!r.ok) toast({ level: "error", message: r.error });
              }),
            )
          }
          onUnpair={() => {
            s.emit("cast:unpair");
            toast({ level: "info", message: "Back on the screen" });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "rename" && <RenameDialog current={name} onSave={applyName} onClose={() => setSheet(null)} />}
      <Toasts toasts={toasts} />
    </div>
  );
}

const RESTART_AFTER = 5; // keep in sync with Room.RESTART_AFTER on the server

/**
 * The TV reports its position ~1/s; interpolate between reports so the UI
 * moves smoothly. Capped 3s past the last report so a stalled screen doesn't race ahead.
 */
function usePlaybackTime(progress: TimedProgress | null, itemId: string | undefined, paused: boolean) {
  const [, rerender] = useState(0);
  const p = itemId && progress?.itemId === itemId ? progress : null;

  useEffect(() => {
    if (paused || !p) return;
    const id = setInterval(() => rerender((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [paused, p]);

  const elapsed = p && !paused ? Math.min(3, (performance.now() - p.at) / 1000) : 0;
  return {
    known: !!p,
    time: p ? Math.min(p.time + elapsed, p.duration || Infinity) : 0,
    duration: p?.duration ?? 0,
  };
}

function HostSeek({
  time,
  duration,
  known,
  noScreen,
  onSeek,
}: {
  time: number;
  duration: number;
  known: boolean;
  noScreen: boolean;
  onSeek: (seconds: number) => void;
}) {
  return (
    <div className="host-seek">
      <Scrubber time={time} duration={duration} onSeek={onSeek} />
      {!known && <div className="muted small center">{noScreen ? "Open the screen to control playback." : "Waiting for a screen…"}</div>}
    </div>
  );
}

function NowPlaying(p: {
  item: QueueItem | null;
  paused: boolean;
  pending: boolean; // the cast is still applying the last pause/resume
  isHost: boolean;
  canSkip: boolean; // allowed to skip this song
  time: number;
  canGoBack: boolean;
  queueLength: number;
  onStart: () => void; // nothing on stage: play the queue
  onSkip: () => void;
  onPause: () => void;
  onRewind: () => void;
}) {
  const restart = !!p.item && p.time >= RESTART_AFTER;
  const backEnabled = restart || p.canGoBack;

  if (!p.item)
    return (
      <section className="now empty">
        <span className="muted">
          {p.queueLength ? "Nothing playing, the queue is waiting." : "Nothing playing. Search for a song to get started!"}
        </span>
        {p.isHost && p.queueLength > 0 && (
          <button className="btn small primary" onClick={p.onStart}>
            ▶ Play the queue
          </button>
        )}
        {p.isHost && p.canGoBack && (
          <button className="btn small" onClick={p.onRewind}>
            ⏮ Replay last song
          </button>
        )}
      </section>
    );
  return (
    <section className="now">
      <img src={p.item.thumb} alt="" />
      <div className="now-info">
        <div className="eyebrow">{p.paused ? "Paused" : p.item.external ? "Playing on YouTube from TV remote" : "Now singing"}</div>
        {!p.item.external && <div className="now-singer">{p.item.singerName}</div>}
        <div className="now-title">{p.item.title}</div>
      </div>
      <div className="now-actions">
        {p.isHost && (
          <button
            className="icon-btn"
            onClick={p.onRewind}
            disabled={!backEnabled}
            aria-label={restart ? "Restart song" : "Previous song"}
            title={restart ? "Restart song" : backEnabled ? "Back to the previous song" : "Can't go back further"}
          >
            ⏮
          </button>
        )}

          <button className="icon-btn" onClick={p.onPause} disabled={p.pending} aria-busy={p.pending} aria-label={p.paused ? "Resume" : "Pause"}>
            {p.paused ? "▶" : "❚❚"}
          </button>

        {p.canSkip && (
          <button className="icon-btn" onClick={p.onSkip} aria-label="Skip" title="Skip this song">
            ⏭
          </button>
        )}
      </div>
    </section>
  );
}

type Sheet = null | "menu" | "history" | "share" | "rename" | "host" | "cast";

function RenameDialog({ current, onSave, onClose }: { current: string; onSave: (n: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(current);
  const clean = value.trim().slice(0, 24);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (clean) onSave(clean);
        }}
      >
        <h2 id="rename-title">Change your name</h2>
        <p className="muted small">Your queued songs will show the new name.</p>
        <input
          className="input"
          autoFocus
          maxLength={24}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder="Your name"
          enterKeyHint="done"
        />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!clean}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

/** A titled group of menu items; groups are separated by a divider. */
function MenuSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="menu-section" role="group" aria-label={title}>
      <div className="menu-section-title">{title}</div>
      {children}
    </div>
  );
}

function MenuSheet({
  isHost,
  screenMode,
  screenUrl,
  code,
  historyCount,
  openControls,
  onToggleOpenControls,
  fairQueue,
  onToggleFairQueue,
  theme,
  onTheme,
  cast,
  playHere,
  onTogglePlayHere,
  onOpen,
  onRename,
  onClose,
}: {
  isHost: boolean;
  screenMode: boolean;
  screenUrl: string; // on the shareable hostname, never localhost/IP (YouTube blocks many videos there)
  code: string;
  historyCount: number;
  openControls: boolean;
  onToggleOpenControls: () => void;
  fairQueue: boolean;
  onToggleFairQueue: () => void;
  theme: ThemeName;
  onTheme: (t: ThemeName) => void;
  cast: RoomState["cast"];
  playHere: boolean;
  onTogglePlayHere: () => void;
  onOpen: (s: Sheet) => void;
  onRename: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet menu" onClick={(e) => e.stopPropagation()} role="menu">
        <h2>Menu</h2>

        <MenuSection title="Room">
          <button className="menu-item" role="menuitem" onClick={() => onOpen("history")}>
            <span className="menu-icon">🕘</span>
            <span className="menu-text">
              Room history
              <span className="muted small">{historyCount ? `${historyCount} song${historyCount > 1 ? "s" : ""} played` : "Nothing played yet"}</span>
            </span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => onOpen("share")}>
            <span className="menu-icon">📨</span>
            <span className="menu-text">
              Invite singers<span className="muted small">QR code and link</span>
            </span>
          </button>
          {!screenMode && (
            <button className="menu-item" role="menuitem" onClick={onRename}>
              <span className="menu-icon">✏️</span>
              <span className="menu-text">
                Change your name<span className="muted small">Updates your queued songs too</span>
              </span>
            </button>
          )}
        </MenuSection>

        {isHost && (
          <MenuSection title="Settings">
            <button className="menu-item" role="menuitemcheckbox" aria-checked={openControls} onClick={onToggleOpenControls}>
              <span className="menu-icon">🎛️</span>
              <span className="menu-text">
                Everyone can control
                <span className="muted small">
                  {openControls ? "On: anyone can skip, go back, seek and reorder" : "Off: only you can skip others, go back, seek and reorder"}
                </span>
              </span>
              <span className={`switch${openControls ? " on" : ""}`} aria-hidden="true" />
            </button>
            <button className="menu-item" role="menuitemcheckbox" aria-checked={fairQueue} onClick={onToggleFairQueue}>
              <span className="menu-icon">⚖️</span>
              <span className="menu-text">
                Fair queue
                <span className="muted small">
                  {fairQueue ? "On: singers with fewer songs queued go first" : "Off: songs play in the order they were added"}
                </span>
              </span>
              <span className={`switch${fairQueue ? " on" : ""}`} aria-hidden="true" />
            </button>
            <div className="menu-item menu-static" role="group" aria-label="Room colour">
              <span className="menu-icon">🎨</span>
              <span className="menu-text">
                Room colour
                <span className="muted small">{THEME_LABELS[theme]}, on every device in this room</span>
              </span>
              <span className="swatches" role="radiogroup" aria-label="Room colour">
                {THEMES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={theme === t}
                    aria-label={THEME_LABELS[t]}
                    title={THEME_LABELS[t]}
                    className={`swatch${theme === t ? " active" : ""}`}
                    data-theme={t}
                    onClick={() => onTheme(t)}
                  />
                ))}
              </span>
            </div>
          </MenuSection>
        )}

        {isHost && (
          <MenuSection title={screenMode ? "Host" : "Host & screen"}>
            <button className="menu-item" role="menuitem" onClick={() => onOpen("host")}>
              <span className="menu-icon">👑</span>
              <span className="menu-text">
                Make someone else host<span className="muted small">Hand the room over to another singer</span>
              </span>
            </button>
            <button className="menu-item" role="menuitem" onClick={() => onOpen("cast")}>
              <span className="menu-icon">📡</span>
              <span className="menu-text">
                Cast to YouTube
                <span className="muted small">
                  {cast ? `${cast.name}: ${cast.connected ? "connected" : "reconnecting…"}` : "Pair with the TV's YouTube app; every video plays"}
                </span>
              </span>
            </button>
            {!screenMode && (
              <button className="menu-item" role="menuitem" onClick={onTogglePlayHere}>
                <span className="menu-icon">{playHere ? "■" : "▶"}</span>
                <span className="menu-text">
                  {playHere ? "Stop playing on this device" : "Play on this device"}
                  <span className="muted small">{playHere ? "Use another screen instead" : "This phone or laptop becomes the screen"}</span>
                </span>
              </button>
            )}
            {!screenMode && (
              <a className="menu-item" role="menuitem" href={screenUrl} target="_blank" rel="noreferrer" onClick={onClose}>
                <span className="menu-icon">📺</span>
                <span className="menu-text">
                  Open the screen<span className="muted small">Replaces any screen already playing</span>
                </span>
              </a>
            )}
          </MenuSection>
        )}
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

const ago = (t?: number) => {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const HISTORY_PAGE = 10;

function HistorySheet({
  items,
  queuedIds,
  onReplay,
  onClose,
}: {
  items: QueueItem[];
  queuedIds: Set<string>;
  onReplay: (item: QueueItem) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // newest first (the server keeps it that way), 10 per page
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / HISTORY_PAGE));
  const current = Math.min(page, pages - 1); // stays valid if the list shrinks
  const shown = items.slice(current * HISTORY_PAGE, (current + 1) * HISTORY_PAGE);
  const listRef = useRef<HTMLUListElement>(null);
  const goTo = (p: number) => {
    setPage(p);
    listRef.current?.scrollTo({ top: 0 });
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
        <h2>Room history</h2>
        <p className="muted small">Most recent first. Replay adds the song to the back of the queue, sung by you.</p>
        {items.length === 0 ? (
          <p className="muted pad">No songs have been played yet.</p>
        ) : (
          <ul className="list scroll" ref={listRef}>
            {shown.map((h) => {
              const queued = queuedIds.has(h.videoId);
              return (
                <li key={h.id} className="song">
                  <img src={h.thumb} alt="" loading="lazy" />
                  <div className="song-info">
                    <div className="song-title">{h.title}</div>
                    <div className="muted small">
                      <b>{h.singerName}</b> · {ago(h.playedAt)}
                    </div>
                  </div>
                  <button
                    className="btn small primary"
                    disabled={queued || busy === h.id}
                    onClick={async () => {
                      setBusy(h.id);
                      await onReplay(h);
                      setBusy(null);
                    }}
                  >
                    {queued ? "Queued" : "Replay"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {pages > 1 && (
          <nav className="pager history-pager" aria-label="History pages">
            <button className="icon-btn" disabled={current === 0} onClick={() => goTo(current - 1)} aria-label="Newer songs">
              ‹
            </button>
            <span className="muted small">
              {current * HISTORY_PAGE + 1}–{current * HISTORY_PAGE + shown.length} of {items.length} · newest first
            </span>
            <button className="icon-btn" disabled={current === pages - 1} onClick={() => goTo(current + 1)} aria-label="Older songs">
              ›
            </button>
          </nav>
        )}
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function Queue(p: { items: QueueItem[]; me: string; isHost: boolean; onRemove: (id: string) => void; onMove: (id: string, to: number) => void }) {
  // Drag by the grip (mouse or touch). Rows stay in DOM order while dragging; the
  // dragged row follows the pointer and the rows it passes slide out of the way.
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; dy: number } | null>(null);
  const start = useRef<{ y: number; scrollY: number; rects: DOMRect[]; gap: number } | null>(null);
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  // after a drop, show the new order until the server's next queue arrives (no snap-back)
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  useEffect(() => setOptimistic(null), [p.items]);

  if (!p.items.length) return <p className="muted center pad">The queue is empty.</p>;

  const byId = new Map(p.items.map((x) => [x.id, x]));
  const items = optimistic ? optimistic.map((id) => byId.get(id)).filter((x): x is QueueItem => !!x) : p.items;

  const commit = (id: string, from: number, to: number) => {
    if (from === to) return;
    const ids = items.map((x) => x.id);
    ids.splice(to, 0, ...ids.splice(from, 1));
    setOptimistic(ids);
    p.onMove(id, to);
  };

  const onDown = (e: React.PointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rects = items.map((x) => rowEls.current.get(x.id)!.getBoundingClientRect());
    const gap = rects.length > 1 ? rects[1].top - rects[0].bottom : 8;
    start.current = { y: e.clientY, scrollY: window.scrollY, rects, gap };
    setDrag({ id, from: index, to: index, dy: 0 });
  };

  const onMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s || !drag) return;
    // keep scrolling when dragging near the edges of the window
    if (e.clientY < 80) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 80) window.scrollBy(0, 12);
    const dy = e.clientY - s.y + (window.scrollY - s.scrollY);
    const r0 = s.rects[drag.from];
    const center = r0.top + r0.height / 2 + dy;
    let to = 0;
    s.rects.forEach((r, i) => {
      if (i !== drag.from && center > r.top + r.height / 2) to++;
    });
    setDrag({ ...drag, to, dy });
  };

  const onUp = () => {
    if (drag) commit(drag.id, drag.from, drag.to);
    setDrag(null);
    start.current = null;
  };

  /** How far a row slides while another one is dragged past it. */
  const shiftFor = (i: number) => {
    const s = start.current;
    if (!drag || !s || i === drag.from) return 0;
    const h = s.rects[drag.from].height + s.gap;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -h;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return h;
    return 0;
  };

  /** The position each row will have if the dragged song is dropped now. */
  const slotFor = (i: number) => {
    if (!drag) return i;
    if (i === drag.from) return drag.to;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return i - 1;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return i + 1;
    return i;
  };

  return (
    <ol className={`list queue${drag ? " dragging" : ""}`}>
      {items.map((item, i) => {
        const mine = item.singerId === p.me;
        const isDragged = drag?.id === item.id;
        const y = isDragged ? drag.dy : shiftFor(i);
        return (
          <li
            key={item.id}
            ref={(el) => {
              if (el) rowEls.current.set(item.id, el);
              else rowEls.current.delete(item.id);
            }}
            className={`song ${mine ? "mine" : ""} ${isDragged ? "lifted" : ""}`}
            style={y ? { transform: `translateY(${y}px)` } : undefined}
          >
            {p.isHost && (
              <button
                className="grip"
                aria-label={`Reorder "${item.title}" (drag, or use the arrow keys)`}
                title="Drag to reorder"
                onPointerDown={(e) => onDown(e, item.id, i)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" && i > 0) commit(item.id, i, i - 1);
                  else if (e.key === "ArrowDown" && i < items.length - 1) commit(item.id, i, i + 1);
                  else return;
                  e.preventDefault();
                }}
              >
                ⠿
              </button>
            )}
            <span className="pos">{slotFor(i) + 1}</span>
            <div className="song-info">
              <div className="song-title">{item.title}</div>
              <div className="small">
                <b>{item.singerName}</b>
                {mine && " (you)"}
              </div>
            </div>
            {p.isHost && (
              // click-only controls for TV remotes / devices that can't drag
              <div className="move">
                <button className="icon-btn sm" disabled={i === 0 || !!drag} onClick={() => commit(item.id, i, i - 1)} aria-label="Move up">
                  ▲
                </button>
                <button
                  className="icon-btn sm"
                  disabled={i === items.length - 1 || !!drag}
                  onClick={() => commit(item.id, i, i + 1)}
                  aria-label="Move down"
                >
                  ▼
                </button>
              </div>
            )}
            {(mine || p.isHost) && (
              <button className="icon-btn sm" onClick={() => p.onRemove(item.id)} aria-label="Remove">
                ✕
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function HostSheet({
  singers,
  currentHost,
  iAmHost,
  iAmScreen,
  onPick,
  onClose,
}: {
  singers: Singer[];
  currentHost: Singer | null;
  iAmHost: boolean;
  iAmScreen: boolean; // the screen is a superhost: it keeps its controls
  onPick: (s: Singer) => void;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState<Singer | null>(null);
  const online = singers.filter((x) => x.online);
  if (confirm)
    return (
      <div className="dialog-backdrop" onClick={() => setConfirm(null)}>
        <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <h2>{currentHost && !iAmHost ? `Move host from ${currentHost.name} to ${confirm.name}?` : `Make ${confirm.name} the host?`}</h2>
          <p className="muted small">
            {iAmHost && iAmScreen
              ? `${confirm.name} gets the host controls. This device keeps its controls because it's the screen.`
              : iAmHost
                ? `${confirm.name} gets the host controls and this menu. You become a regular singer.`
                : currentHost
                  ? `${currentHost.name} loses host and ${confirm.name} gets it. The screen keeps its host controls.`
                  : `${confirm.name} becomes the host. The screen keeps its host controls.`}
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => onPick(confirm)}>
              Make host
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet menu" onClick={(e) => e.stopPropagation()} role="menu">
        <h2>Make someone else host</h2>
        <p className="muted small host-now">
          {currentHost ? (
            <>
              Current host: <b>{currentHost.name}</b>
              {iAmHost && " (you)"}
            </>
          ) : (
            "Nobody is host right now."
          )}
        </p>
        {online.length === 0 && <p className="muted small center">Nobody else is in the room right now.</p>}
        {online.map((x) => (
          <button key={x.id} className="menu-item" role="menuitem" onClick={() => setConfirm(x)}>
            <span className="menu-icon">{x.name.slice(0, 1).toUpperCase()}</span>
            <span className="menu-text">{x.name}</span>
          </button>
        ))}
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function CastSheet({
  cast,
  casting,
  onPair,
  onUnpair,
  onClose,
}: {
  cast: RoomState["cast"];
  casting: boolean;
  onPair: (code: string) => Promise<boolean>;
  onUnpair: () => void;
  onClose: () => void;
}) {
  const [digits, setDigits] = useState("");
  const [busy, setBusy] = useState(false);
  const pretty = digits.replace(/(\d{3})(?=\d)/g, "$1 ");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (digits.length !== 12 || busy) return;
    setBusy(true);
    const ok = await onPair(digits);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Cast to YouTube</h2>
        {cast && casting ? (
          <>
            <p>
              Playing on <b>{cast.name}</b> ({cast.connected ? "connected" : "reconnecting…"}). Every video works here, and ads follow the account the TV is signed in to.
            </p>
            <div className="row">
              <button className="btn" onClick={onUnpair}>
                Stop casting
              </button>
              <button className="btn" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <ol className="muted small">
              <li>Open the TV's YouTube app (signed in to the Premium account).</li>
              <li>Go to Settings → Link with TV code.</li>
              <li>Type the 12-digit code here.</li>
            </ol>
            <input
              className="input"
              inputMode="numeric"
              autoComplete="off"
              placeholder="123 456 789 012"
              aria-label="Link code"
              value={pretty}
              onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 12))}
              autoFocus
            />
            <div className="row">
              <button className="btn primary" disabled={digits.length !== 12 || busy}>
                {busy ? "Connecting…" : "Pair"}
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ShareSheet({ code, isHost, onClose }: { code: string; isHost: boolean; onClose: () => void }) {
  const url = useJoinUrl(code);
  const screenUrl = url.replace(/\/r\/\w+$/, `/r/${code}/screen`);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Invite singers</h2>
        <img className="qr" src={qrSrc(url)} alt={`QR code for ${url}`} />
        <p className="big-code">{code}</p>
        <p className="muted small break">{url}</p>
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              navigator.share ? navigator.share({ title: "Join my karaoke room", url }).catch(() => {}) : navigator.clipboard?.writeText(url)
            }
          >
            Share link
          </button>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
        {isHost && (
          <p className="muted small">
            Screen: open <span className="break">{screenUrl}</span> in the TV's browser.
          </p>
        )}
      </div>
    </div>
  );
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
