import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../src/atomicWrite.ts";
import { SiteSettings } from "../src/siteSettings.ts";

describe("atomic file writes", () => {
  it("lets overlapping saves finish in order, with the last one winning and no temp files left", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "karaoke-atomic-"));
    try {
      const file = path.join(dir, "data.json");
      await Promise.all(Array.from({ length: 25 }, (_, i) => writeFileAtomic(file, `{"n":${i}}\n`)));
      assert.equal(readFileSync(file, "utf8"), '{"n":24}\n');
      assert.deepEqual(readdirSync(dir), ["data.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps SiteSettings consistent when two settings change at once", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "karaoke-settings-"));
    try {
      const s = new SiteSettings(dir);
      await Promise.all([s.setAdminTheme("blue"), s.setVerboseCastLog(true)]);
      const saved = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
      assert.equal(saved.adminTheme, "blue");
      assert.equal(saved.verboseCastLog, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
