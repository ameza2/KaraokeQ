import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../../lib/theme.ts";
import Search from "../search/Search.tsx";
import ScreenPlayer, { takenOverText, type PlayerHandle, type ReplacedBy } from "../screen/ScreenPlayer.tsx";
import { useLanHost } from "../../lib/joinUrl.ts";
import { isPlayerDevice, setPlayerDevice } from "../../lib/storage.ts";
import { useRoom } from "../../lib/useRoom.ts";
import Room from "./RoomPage.tsx";
import { usePlaybackTime } from "./usePlaybackTime.ts";
import { HostSeek, NowPlaying } from "./NowPlaying.tsx";
import { RenameDialog } from "./RenameDialog.tsx";
import { MenuSheet } from "./MenuSheet.tsx";
import { HistorySheet } from "./HistorySheet.tsx";
import { Queue } from "./Queue.tsx";
import { HostSheet } from "./HostSheet.tsx";
import { CastSheet } from "./CastSheet.tsx";
import { ShareSheet } from "./ShareSheet.tsx";
import { Toasts } from "./Toasts.tsx";
import { duration } from "../admin/format.ts";

export function RoomView({ code, name, onRename, screenMode = false }: { code: string; name: string; onRename: (n: string) => void; screenMode?: boolean }) {
  const { me, state, isHost, isScreenDevice, hostPowers, canControl, error, connected, toasts, toast, progress, setProgress, socket } = useRoom(code, name, screenMode);
  useTheme(state?.settings.theme, `room:${code}`); // the room's colour preset, chosen by its host
  const [tab, setTab] = useState<"search" | "queue">("search");
  const [sheet, setSheet] = useState<SheetName>(null);
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

export type SheetName = null | "menu" | "history" | "share" | "rename" | "host" | "cast";
