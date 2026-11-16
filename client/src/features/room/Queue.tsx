import { useEffect, useRef, useState } from "react";
import { type QueueItem } from "@karaoke/shared";

export function Queue(p: { items: QueueItem[]; me: string; isHost: boolean; onRemove: (id: string) => void; onMove: (id: string, to: number) => void }) {
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
