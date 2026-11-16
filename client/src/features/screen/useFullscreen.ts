import { useEffect, useState, type RefObject } from "react";

/**
 * Full screen for the player's root element: the real Fullscreen API where there is one, and a
 * CSS full-viewport fallback otherwise (iPhone has no element fullscreen). `full` is what the
 * page should render; the hook keeps it in step when the browser leaves full screen by itself.
 */
export function useFullscreen(root: RefObject<HTMLElement | null>, startFull: boolean) {
  const [full, setFull] = useState(startFull);

  const enterNative = async () => {
    const el = root.current;
    if (!el?.requestFullscreen || document.fullscreenElement) return;
    await el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape").catch(() => {});
  };

  // Screen mode: go full screen right away. Real fullscreen needs a recent click
  // (e.g. the landing page's Create/Join); otherwise the CSS version fills the window.
  useEffect(() => {
    if (startFull) void enterNative();
  }, []);

  const toggle = async () => {
    if (full) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setFull(false);
      return;
    }
    setFull(true);
    await enterNative();
  };

  /** Leave full screen: a hidden element left fullscreen would cover the page in black. */
  const exit = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setFull(false);
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

  return { full, setFull, enterNative, toggle, exit };
}
