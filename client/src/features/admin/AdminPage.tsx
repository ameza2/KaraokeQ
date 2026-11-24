import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DEFAULT_THEME, type AdminSession } from "@karaoke/shared";
import { useTheme } from "../../lib/theme.ts";
import { api, ApiError } from "../../lib/adminApi.ts";
import { SignIn } from "./SignIn.tsx";
import { PasswordForm } from "./PasswordForm.tsx";
import { RoomsTab } from "./RoomsTab.tsx";
import { AppearanceTab } from "./AppearanceTab.tsx";
import { DebugTab } from "./DebugTab.tsx";
import { SecurityTab } from "./SecurityTab.tsx";

type Tab = "rooms" | "security" | "appearance" | "debug" | "account";

const TABS: { id: Tab; label: string }[] = [
  { id: "rooms", label: "Rooms" },
  { id: "security", label: "Security" },
  { id: "appearance", label: "Appearance" },
  { id: "debug", label: "Debug" },
  { id: "account", label: "Account" },
];

export default function Admin() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [tab, setTab] = useState<Tab>("rooms");
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null);

  const signedOut = useCallback(() => setSession((s) => ({ authenticated: false, adminTheme: s?.adminTheme ?? DEFAULT_THEME })), []);
  const refresh = useCallback(() => api<AdminSession>("GET", "/session").then(setSession, signedOut), [signedOut]);
  useTheme(session?.adminTheme, "admin"); // the admin pages' own colour preset
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    document.title = "Admin · Karaoke Queue";
    return () => void (document.title = "Karaoke Queue");
  }, []);

  const say = useCallback((text: string, error = false) => {
    setFlash({ text, error });
    setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), error ? 6000 : 3500);
  }, []);
  /** Run an admin action; a lost session drops back to the sign-in form. */
  const run = useCallback(
    async <T,>(action: () => Promise<T>, done?: string): Promise<T | undefined> => {
      try {
        const result = await action();
        if (done) say(done);
        return result;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) signedOut();
        else say((e as Error).message, true);
        return undefined;
      }
    },
    [say, signedOut],
  );

  if (!session) return <main className="home muted">Loading…</main>;
  if (!session.authenticated) return <SignIn onDone={setSession} />;
  if (session.mustChangePassword)
    return (
      <main className="home admin-auth">
        <div className="orb" aria-hidden="true" />
        <h1>Choose a new password</h1>
        <p className="muted">You signed in with the default password. Set your own before using the admin area.</p>
        <PasswordForm currentLabel="Default password" onDone={() => void refresh()} />
        <button className="link" onClick={() => void api("POST", "/logout").then(refresh)}>
          Sign out
        </button>
      </main>
    );

  return (
    <div className="app admin">
      <header className="topbar">
        <div>
          <div className="room-code">
            Admin <span className="pill">{session.username}</span>
          </div>
          <div className="muted small">Karaoke Queue</div>
        </div>
        <div className="topbar-actions">
          <Link className="btn small" to="/">
            Home
          </Link>
          <button className="btn small" onClick={() => void api("POST", "/logout").then(refresh)}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabs admin-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "rooms" && <RoomsTab run={run} />}
      {tab === "security" && <SecurityTab run={run} />}
      {tab === "appearance" && <AppearanceTab run={run} theme={session.adminTheme} onChange={(adminTheme) => setSession({ ...session, adminTheme })} />}
      {tab === "debug" && <DebugTab run={run} />}
      {tab === "account" && (
        <section className="admin-panel">
          <h2>Change password</h2>
          <p className="muted small">
            Stored only as a salted hash in the server's data folder. Forgot it? Delete <code>data/admin/credentials.json</code> on the server and the login
            goes back to the default, which must then be changed again.
          </p>
          <PasswordForm currentLabel="Current password" onDone={() => say("Password changed")} />
        </section>
      )}

      {flash && (
        <div className="toasts" aria-live="polite">
          <div className={`toast ${flash.error ? "error" : "info"}`}>{flash.text}</div>
        </div>
      )}
    </div>
  );
}

// ---------- sign-in ----------
