import type { ReactNode } from "react";

/** A menu row with an on/off switch: icon, title, a hint line and the switch. */
export function ToggleItem({ icon, title, hint, on, onToggle }: { icon: ReactNode; title: string; hint: string; on: boolean; onToggle: () => void }) {
  return (
    <button className="menu-item" role="menuitemcheckbox" aria-checked={on} onClick={onToggle}>
      <span className="menu-icon">{icon}</span>
      <span className="menu-text">
        {title}
        <span className="muted small">{hint}</span>
      </span>
      <span className={`switch${on ? " on" : ""}`} aria-hidden="true" />
    </button>
  );
}
