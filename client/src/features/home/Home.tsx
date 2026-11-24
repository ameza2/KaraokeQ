import { useState, type FormEvent } from "react";
import type { ApiError, CreateRoomResponse, RoomExistsResponse } from "@karaoke/shared";
import { useNavigate, Link } from "react-router-dom";
import { setHostToken } from "../../lib/storage.ts";
import { useLanHost } from "../../lib/joinUrl.ts";

export default function Home() {
  const navigate = useNavigate();
  const lanHost = useLanHost();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createRoom() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: "client" }),
      });
      if (!res.ok) throw new Error();
      const { code, hostToken }: CreateRoomResponse = await res.json();
      if (hostToken) setHostToken(code, hostToken);
      navigate(`/r/${code}`);
    } catch {
      setError("Couldn't create a room. Is the server running?");
      setBusy(false);
    }
  }

  async function join(e: FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return;
    const res = await fetch(`/api/rooms/${c}`);
    const body: Partial<RoomExistsResponse & ApiError> = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error ?? "Couldn't check that code. Try again.");
    const exists = body.exists;
    if (exists) navigate(`/r/${c}`);
    else setError(`No room with code ${c}.`);
  }

  return (
    <main className="home">
      <div className="orb" aria-hidden="true" />
      <h1>Karaoke Queue</h1>
      <p className="muted">Everyone queues songs from their phone. Songs play in turn.</p>

      <button className="btn primary big" onClick={createRoom} disabled={busy}>
        {busy ? "Creating…" : "Start a party"}
      </button>
      <p className="muted small hint-line">
        Then open <b>{lanHost}/screen</b> on the TV and join with your room code.
      </p>

      <div className="divider">or join one</div>

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
      <Link className="admin-link muted small" to="/admin">
        Admin
      </Link>
    </main>
  );
}
