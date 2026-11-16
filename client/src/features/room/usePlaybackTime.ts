import { useEffect, useState } from "react";
import { type TimedProgress } from "../../lib/useRoom.ts";

/**
 * The TV reports its position ~1/s; interpolate between reports so the UI
 * moves smoothly. Capped 3s past the last report so a stalled screen doesn't race ahead.
 */
export function usePlaybackTime(progress: TimedProgress | null, itemId: string | undefined, paused: boolean) {
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
