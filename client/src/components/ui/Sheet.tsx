import type { ReactNode } from "react";

/** A bottom sheet over a dimmed backdrop; tapping the backdrop closes it. */
export function Sheet({ onClose, className = "", role, children }: { onClose: () => void; className?: string; role?: string; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet${className ? ` ${className}` : ""}`} role={role} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
