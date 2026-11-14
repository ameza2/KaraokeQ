import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useLanHost } from "../lib/joinUrl.ts";
import { getLastScreenRoom } from "../lib/storage.ts";

/**
 * /screen — landing page for the TV (or laptop on HDMI). Create a session or join
 * one; either way this device becomes the room's screen: videos play here, full
 * screen, and it gets the host's controls. The first *person* to join is the host.
 * The last session's code is pre-filled but never joined automatically.
 */
export default function ScreenLanding() {
  const navigate = useNavigate();
  const lanHost = useLanHost();
  const [code, setCode] = useState(getLastScreenRoom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: "screen" }),
      });
      if (!res.ok) throw new Error();
      const { code } = await res.json();
      navigate(`/r/${code}/screen`);
    } catch {
      setError("Couldn't create a session. Is the server running?");
      setBusy(false);
    }
  }

  async function join(e: FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return;
    const { exists } = await fetch(`/api/rooms/${c}`).then((r) => r.json());
    if (exists) navigate(`/r/${c}/screen`);
    else setError(`No session with code ${c}.`);
  }

  return (
    <main className="home">
      <div className="orb" aria-hidden="true" />
      <h1>Karaoke Screen</h1>
      <p className="muted">This device plays the videos. Guests scan the code on screen to queue songs.</p>

      <button className="btn primary big" onClick={create} disabled={busy}>
        {busy ? "Creating…" : "Create a session"}
      </button>
      <p className="muted small hint-line">The first person to join becomes the host.</p>

      <div className="divider">or show an existing one</div>

      <form onSubmit={join} className="row">
        <input
          className="input code-input"
          placeholder="Room code"
          value={code}
          maxLength={4}
          autoCapitalize="characters"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button className="btn">Join</button>
      </form>

      {error && <p className="error">{error}</p>}
      <p className="muted small hint-line">
        Phones use <b>{lanHost}</b>
      </p>
    </main>
  );
}
