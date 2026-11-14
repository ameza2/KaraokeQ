import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_THEME, THEMES, type ThemeName } from "@karaoke/shared";

/**
 * Settings the admin controls that aren't tied to a room (currently the colour
 * preset of the admin pages; each room keeps its own preset in its settings).
 * Kept in `<data>/settings.json`; behind this class so a database can replace it.
 */
export interface SiteSettingsData {
  adminTheme: ThemeName;
}

export const isTheme = (x: unknown): x is ThemeName => typeof x === "string" && (THEMES as readonly string[]).includes(x);

export class SiteSettings {
  private readonly file: string;
  private data: SiteSettingsData = { adminTheme: DEFAULT_THEME };

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
    mkdirSync(dataDir, { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (isTheme(saved?.adminTheme)) this.data.adminTheme = saved.adminTheme;
    } catch {
      // no file yet (or unreadable): defaults
    }
  }

  get adminTheme() {
    return this.data.adminTheme;
  }

  async setAdminTheme(adminTheme: ThemeName) {
    this.data = { adminTheme };
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
  }
}
