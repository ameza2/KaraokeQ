import { THEMES, THEME_LABELS, type ThemeName } from "@karaoke/shared";
import { api, type Run } from "../../lib/adminApi.ts";
import Admin from "./AdminPage.tsx";

export function AppearanceTab({ run, theme, onChange }: { run: Run; theme: ThemeName; onChange: (t: ThemeName) => void }) {
  return (
    <section className="admin-panel">
      <h2>Admin colour preset</h2>
      <p className="muted small">
        Changes the admin pages only, on every device you sign in from. Each room has its own colour: its host picks it in the room's menu, and you can set
        it per room on the Rooms tab.
      </p>
      <div className="theme-grid" role="radiogroup" aria-label="Colour preset">
        {THEMES.map((t) => (
          <button
            key={t}
            role="radio"
            aria-checked={theme === t}
            className={`theme-card ${theme === t ? "active" : ""}`}
            data-theme={t}
            onClick={async () => {
              const r = await run(() => api<{ theme: ThemeName }>("PUT", "/theme", { theme: t }), `${THEME_LABELS[t]} applied`);
              if (r) onChange(r.theme);
            }}
          >
            <span className="theme-swatch" aria-hidden="true" />
            <span className="theme-name">{THEME_LABELS[t]}</span>
            <span className="muted small">{theme === t ? "Current" : "Use this"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------- debug ----------
