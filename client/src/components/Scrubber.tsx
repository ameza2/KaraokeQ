import { useState } from "react";

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
  const commit = () => {
    if (dragging !== null) seek(dragging);
    setDragging(null);
  };

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
        onChange={(e) => {
          setDragging(Number(e.target.value));
          onActivity?.();
        }}
        onPointerUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        onBlur={() => setDragging(null)}
        aria-label="Seek"
      />
      <span className="seek-time">{fmtTime(duration)}</span>
      <button className="seek-jump" disabled={disabled} onClick={() => seek(time + 10)} aria-label="Forward 10 seconds">
        10 ⟳
      </button>
    </div>
  );
}
