import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicWrite.ts";
import { DEFAULT_THEME, THEMES, type ThemeName } from "@karaoke/shared";

/**
 * Settings the admin controls that aren't tied to a room (currently the colour
 * preset of the admin pages; each room keeps its own preset in its settings).
 * Kept in `<data>/settings.json`; behind this class so a database can replace it.
 */
export interface SiteSettingsData {
  adminTheme: ThemeName;
  /** Log every YouTube cast command and TV event (admin Debug tab). */
  verboseCastLog: boolean;
}

export const isTheme = (x: unknown): x is ThemeName => typeof x === "string" && (THEMES as readonly string[]).includes(x);

export class SiteSettings {
  private readonly file: string;
  private data: SiteSettingsData = { adminTheme: DEFAULT_THEME, verboseCastLog: false };

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
    mkdirSync(dataDir, { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (isTheme(saved?.adminTheme)) this.data.adminTheme = saved.adminTheme;
      if (typeof saved?.verboseCastLog === "boolean") this.data.verboseCastLog = saved.verboseCastLog;
    } catch {
      // no file yet (or unreadable): defaults
    }
  }

  get adminTheme() {
    return this.data.adminTheme;
  }

  get verboseCastLog() {
    return this.data.verboseCastLog;
  }

  async setAdminTheme(adminTheme: ThemeName) {
    this.data = { ...this.data, adminTheme };
    await this.save();
  }

  async setVerboseCastLog(verboseCastLog: boolean) {
    this.data = { ...this.data, verboseCastLog };
    await this.save();
  }

  private async save() {
    await writeFileAtomic(this.file, JSON.stringify(this.data, null, 2) + "\n");
  }
}
