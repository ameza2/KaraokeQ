import { thumbUrl, type QueueItem } from "@karaoke/shared";
import { type TimedProgress } from "../../lib/useRoom.ts";
import { usePlaybackTime } from "./usePlaybackTime.ts";
import Scrubber from "../../components/Scrubber.tsx";

const RESTART_AFTER = 5; // keep in sync with Room.RESTART_AFTER on the server

export function HostSeek({
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

export function NowPlaying(p: {
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
      <img src={thumbUrl(p.item.videoId)} alt="" />
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

/**
 * Now playing plus the host's seek bar. It owns the 250ms playback clock, so only this
 * panel re-renders while a song plays, not the whole room page.
 */
export function PlaybackPanel(p: {
  progress: TimedProgress | null;
  item: QueueItem | null;
  paused: boolean;
  pending: boolean;
  isHost: boolean;
  canSkip: boolean;
  canGoBack: boolean;
  queueLength: number;
  showSeek: boolean;
  noScreen: boolean;
  onSeek: (seconds: number) => void;
  onStart: () => void;
  onSkip: () => void;
  onPause: () => void;
  onRewind: () => void;
}) {
  const playback = usePlaybackTime(p.progress, p.item?.id, p.paused);
  return (
    <>
      <NowPlaying
        item={p.item}
        paused={p.paused}
        pending={p.pending}
        isHost={p.isHost}
        canSkip={p.canSkip}
        time={playback.time}
        canGoBack={p.canGoBack}
        queueLength={p.queueLength}
        onStart={p.onStart}
        onSkip={p.onSkip}
        onPause={p.onPause}
        onRewind={p.onRewind}
      />
      {p.showSeek && <HostSeek time={playback.time} duration={playback.duration} known={playback.known} noScreen={p.noScreen} onSeek={p.onSeek} />}
    </>
  );
}
