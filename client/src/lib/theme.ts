import { useEffect, useLayoutEffect } from "react";
import { DEFAULT_THEME, THEMES, type ThemeName } from "@karaoke/shared";
import { load, save } from "./storage.ts";

/**
 * Colour presets. A room page wears its room's preset (chosen by the host) and
 * the admin pages wear the admin's; everything else uses the default.
 *
 * The preset is a `data-theme` attribute on <html>; styles.css overrides the
 * colour tokens per preset.
 */
const isTheme = (x: unknown): x is ThemeName => typeof x === "string" && (THEMES as readonly string[]).includes(x);

function setTheme(theme: ThemeName) {
  const root = document.documentElement;
  if (theme === DEFAULT_THEME) delete root.dataset.theme;
  else root.dataset.theme = theme;
  // the browser chrome (phone status bar) follows the page background
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}

/**
 * Wear `theme` while the calling page is mounted, and go back to the default
 * when it unmounts. Until the real value arrives (`undefined`), the preset this
 * device last saw for `cacheKey` is used, so the page doesn't flash orange.
 */
export function useTheme(theme: ThemeName | undefined, cacheKey: string) {
  useLayoutEffect(() => {
    const key = `karaoke:theme:${cacheKey}`;
    if (theme) save(key, theme);
    const cached = load(key);
    setTheme(theme ?? (isTheme(cached) ? cached : DEFAULT_THEME));
  }, [theme, cacheKey]);
  useEffect(() => () => setTheme(DEFAULT_THEME), []);
}
