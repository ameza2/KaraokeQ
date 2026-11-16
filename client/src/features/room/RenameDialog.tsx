import { useEffect, useState } from "react";

export function RenameDialog({ current, onSave, onClose }: { current: string; onSave: (n: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(current);
  const clean = value.trim().slice(0, 24);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (clean) onSave(clean);
        }}
      >
        <h2 id="rename-title">Change your name</h2>
        <p className="muted small">Your queued songs will show the new name.</p>
        <input
          className="input"
          autoFocus
          maxLength={24}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder="Your name"
          enterKeyHint="done"
        />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!clean}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
