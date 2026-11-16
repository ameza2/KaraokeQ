import { useRef, useState } from "react";
import { type QueueItem } from "@karaoke/shared";
import Room from "./RoomPage.tsx";
import { Sheet } from "../../components/ui/Sheet.tsx";

export const ago = (t?: number) => {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const HISTORY_PAGE = 10;

export function HistorySheet({
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
    <Sheet onClose={onClose} className="tall">
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
    </Sheet>
  );
}
