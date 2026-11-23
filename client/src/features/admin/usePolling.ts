import { useEffect, useRef } from "react";

/** Re-run `load` every `ms` while mounted (and once right away). */
export function usePolling(load: () => Promise<void>, ms: number, enabled = true) {
  const ref = useRef(load);
  ref.current = load;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = () => void ref.current().catch(() => {});
    tick();
    const t = setInterval(() => alive && document.visibilityState === "visible" && tick(), ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ms, enabled]);
}

// ---------- formatting ----------
