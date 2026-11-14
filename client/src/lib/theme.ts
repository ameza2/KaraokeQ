import { DEFAULT_THEME, THEMES, type ThemeName } from "@karaoke/shared";
import { getServerInfo } from "./joinUrl.ts";
import { load, save } from "./storage.ts";

/**
 * The site-wide colour preset, chosen by the admin. It is a `data-theme`
 * attribute on <html>; styles.css overrides the colour tokens per preset.
 */
const KEY = "karaoke:theme";
const isTheme = (x: unknown): x is ThemeName => typeof x === "string" && (THEMES as readonly string[]).includes(x);

export function applyTheme(theme: ThemeName) {
  const root = document.documentElement;
  if (theme === DEFAULT_THEME) delete root.dataset.theme;
  else root.dataset.theme = theme;
  save(KEY, theme);
  // the browser chrome (phone status bar) follows the page background
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}

/** Use the last known preset right away (no flash), then the server's current one. */
export function initTheme() {
  const cached = load(KEY);
  if (isTheme(cached)) applyTheme(cached);
  void getServerInfo().then((info) => {
    if (isTheme(info.theme)) applyTheme(info.theme);
  });
}
