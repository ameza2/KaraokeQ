import { useState } from "react";
import { Link } from "react-router-dom";
import { type RoomState } from "@karaoke/shared";
import { Sheet } from "../../components/ui/Sheet.tsx";

export function CastSheet({
  cast,
  casting,
  onPair,
  onUnpair,
  onClose,
}: {
  cast: RoomState["cast"];
  casting: boolean;
  onPair: (code: string) => Promise<boolean>;
  onUnpair: () => void;
  onClose: () => void;
}) {
  const [digits, setDigits] = useState("");
  const [busy, setBusy] = useState(false);
  const pretty = digits.replace(/(\d{3})(?=\d)/g, "$1 ");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (digits.length !== 12 || busy) return;
    setBusy(true);
    const ok = await onPair(digits);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet onClose={onClose}>
      <h2>Cast to YouTube</h2>
      {cast && casting ? (
        <>
          <p>
            Playing on <b>{cast.name}</b> ({cast.connected ? "connected" : "reconnecting…"}). Every video works here, and ads follow the account the TV is signed in to.
          </p>
          <div className="row">
            <button className="btn" onClick={onUnpair}>
              Stop casting
            </button>
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <ol className="muted small">
            <li>Open the TV's YouTube app (signed in to the Premium account).</li>
            <li>Go to Settings → Link with TV code.</li>
            <li>Type the 12-digit code here.</li>
          </ol>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="off"
            placeholder="123 456 789 012"
            aria-label="Link code"
            value={pretty}
            onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 12))}
            autoFocus
          />
          <div className="row">
            <button className="btn primary" disabled={digits.length !== 12 || busy}>
              {busy ? "Connecting…" : "Pair"}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
