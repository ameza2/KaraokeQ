import { useState } from "react";
import { type Singer } from "@karaoke/shared";

export function HostSheet({
  singers,
  currentHost,
  iAmHost,
  iAmScreen,
  onPick,
  onClose,
}: {
  singers: Singer[];
  currentHost: Singer | null;
  iAmHost: boolean;
  iAmScreen: boolean; // the screen is a superhost: it keeps its controls
  onPick: (s: Singer) => void;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState<Singer | null>(null);
  const online = singers.filter((x) => x.online);
  if (confirm)
    return (
      <div className="dialog-backdrop" onClick={() => setConfirm(null)}>
        <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <h2>{currentHost && !iAmHost ? `Move host from ${currentHost.name} to ${confirm.name}?` : `Make ${confirm.name} the host?`}</h2>
          <p className="muted small">
            {iAmHost && iAmScreen
              ? `${confirm.name} gets the host controls. This device keeps its controls because it's the screen.`
              : iAmHost
                ? `${confirm.name} gets the host controls and this menu. You become a regular singer.`
                : currentHost
                  ? `${currentHost.name} loses host and ${confirm.name} gets it. The screen keeps its host controls.`
                  : `${confirm.name} becomes the host. The screen keeps its host controls.`}
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => onPick(confirm)}>
              Make host
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet menu" onClick={(e) => e.stopPropagation()} role="menu">
        <h2>Make someone else host</h2>
        <p className="muted small host-now">
          {currentHost ? (
            <>
              Current host: <b>{currentHost.name}</b>
              {iAmHost && " (you)"}
            </>
          ) : (
            "Nobody is host right now."
          )}
        </p>
        {online.length === 0 && <p className="muted small center">Nobody else is in the room right now.</p>}
        {online.map((x) => (
          <button key={x.id} className="menu-item" role="menuitem" onClick={() => setConfirm(x)}>
            <span className="menu-icon">{x.name.slice(0, 1).toUpperCase()}</span>
            <span className="menu-text">{x.name}</span>
          </button>
        ))}
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
