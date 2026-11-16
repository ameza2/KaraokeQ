import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { type AdminSession } from "@karaoke/shared";
import { api } from "../../lib/adminApi.ts";
import Admin from "./AdminPage.tsx";

export function SignIn({ onDone }: { onDone: (s: AdminSession) => void }) {
  const [username, setUsername] = useState("Administrator");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<AdminSession>("POST", "/login", { username, password }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home admin-auth">
      <div className="orb" aria-hidden="true" />
      <h1>Admin</h1>
      <p className="muted">Sign in to manage rooms, appearance and logs.</p>
      <form className="stack admin-form" onSubmit={submit}>
        <label className="field">
          <span className="muted small">Username</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span className="muted small">Password</span>
          <input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <Link className="link" to="/">
        Back home
      </Link>
    </main>
  );
}
