import { useEffect, useRef, useState } from "react";

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60)
    .toString()
    .padStart(2, "0");
  return h ? `${h}:${m.toString().padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/**
 * YouTube-style scrubber shared by the TV screen and the host's phone:
 * drag the bar to seek (applied on release), or jump ±10 seconds.
 */
export default function Scrubber({
  time,
  duration,
  onSeek,
  onActivity,
  className = "",
  readOnly = false,
}: {
  time: number;
  duration: number;
  onSeek: (seconds: number) => void;
  onActivity?: () => void;
  className?: string;
  readOnly?: boolean; // show position only (no permission to seek)
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = Math.min(dragging ?? time, duration || Infinity);
  const pct = duration ? (shown / duration) * 100 : 0;
  const disabled = !duration || readOnly;

  const seek = (to: number) => {
    if (!duration) return;
    onSeek(Math.max(0, Math.min(duration - 0.5, to)));
  };
  // A drag is a gesture: it starts on pointer/touch/key down and ends once on release.
  // Browsers can fire a last "input" event after the release; without the `active` gate it
  // would put the slider back into dragging mode with the old value (stuck until blur).
  const draggingRef = useRef<number | null>(null);
  draggingRef.current = dragging;
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const active = useRef(false);
  const ending = useRef(false);
  const viaPointer = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  const begin = (pointer: boolean) => {
    active.current = true;
    viaPointer.current = pointer;
  };
  const commit = () => {
    if (!active.current || ending.current) return; // already ending (pointer + touch both fire)
    ending.current = true;
    // wait a tick so a late final "input" event lands before the value is read
    setTimeout(() => {
      ending.current = false;
      active.current = false;
      const v = draggingRef.current;
      draggingRef.current = null;
      if (v !== null) seekRef.current(v);
      setDragging(null);
      if (viaPointer.current) input.current?.blur(); // don't leave focus on the slider after a click or drag
    }, 40);
  };
  const cancel = () => {
    active.current = false;
    draggingRef.current = null;
    setDragging(null);
  };
  // Released off the slider, or the browser cancelled the gesture: the slider's own
  // handlers never fire, so listen on the window while dragging.
  const isDragging = dragging !== null;
  useEffect(() => {
    if (!isDragging) return;
    const end = () => commit();
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("touchend", end);
    window.addEventListener("mouseup", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("touchend", end);
      window.removeEventListener("mouseup", end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);

  return (
    <div className={`scrubber ${dragging !== null ? "dragging" : ""} ${className}`} onPointerMove={onActivity}>
      <button className="seek-jump" disabled={disabled} onClick={() => seek(time - 10)} aria-label="Back 10 seconds">
        ⟲ 10
      </button>
      <span className="seek-time">{fmtTime(shown)}</span>
      <input
        type="range"
        min={0}
        max={duration || 1}
        step={0.5}
        value={shown}
        disabled={disabled}
        style={{ ["--pct" as string]: `${pct}%` }}
        ref={input}
        onChange={(e) => {
          if (!active.current) return; // stray event after a release
          setDragging(Number(e.target.value));
          onActivity?.();
        }}
        onPointerDown={() => begin(true)}
        onTouchStart={() => begin(true)}
        onKeyDown={() => begin(false)}
        onPointerUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        onBlur={cancel}
        aria-label="Seek"
      />
      <span className="seek-time">{fmtTime(duration)}</span>
      <button className="seek-jump" disabled={disabled} onClick={() => seek(time + 10)} aria-label="Forward 10 seconds">
        10 ⟳
      </button>
    </div>
  );
}
