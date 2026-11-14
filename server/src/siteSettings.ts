import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_THEME, THEMES, type ThemeName } from "@karaoke/shared";

/**
 * Site-wide settings the admin controls (currently just the colour preset).
 * Kept in `<data>/settings.json`; behind this class so a database can replace it.
 */
export interface SiteSettingsData {
  theme: ThemeName;
}

export const isTheme = (x: unknown): x is ThemeName => typeof x === "string" && (THEMES as readonly string[]).includes(x);

export class SiteSettings {
  private readonly file: string;
  private data: SiteSettingsData = { theme: DEFAULT_THEME };

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
    mkdirSync(dataDir, { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (isTheme(saved?.theme)) this.data.theme = saved.theme;
    } catch {
      // no file yet (or unreadable): defaults
    }
  }

  get theme() {
    return this.data.theme;
  }

  async setTheme(theme: ThemeName) {
    this.data = { ...this.data, theme };
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
  }
}
