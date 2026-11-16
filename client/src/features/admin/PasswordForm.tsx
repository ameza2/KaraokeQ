import { useState, type FormEvent } from "react";
import { api } from "../../lib/adminApi.ts";

export function PasswordForm({ currentLabel, onDone }: { currentLabel: string; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) return setError("The two new passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/password", { current, next });
      setCurrent("");
      setNext("");
      setAgain("");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack admin-form" onSubmit={submit}>
      <label className="field">
        <span className="muted small">{currentLabel}</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        <span className="muted small">New password (8 characters or more)</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="field">
        <span className="muted small">New password again</span>
        <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      <button className="btn primary" disabled={busy || !current || !next || !again}>
        {busy ? "Saving…" : "Save password"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// ---------- rooms ----------
