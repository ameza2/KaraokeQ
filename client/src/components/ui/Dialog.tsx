import type { FormEvent, ReactNode } from "react";

/** A centred confirm/prompt dialog; renders a <form> when `onSubmit` is given. */
export function Dialog({
  onClose,
  onSubmit,
  labelledBy,
  children,
}: {
  onClose: () => void;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  labelledBy?: string;
  children: ReactNode;
}) {
  const common = { className: "dialog", role: "dialog", "aria-modal": true as const, "aria-labelledby": labelledBy, onClick: (e: React.MouseEvent) => e.stopPropagation() };
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      {onSubmit ? (
        <form {...common} onSubmit={onSubmit}>
          {children}
        </form>
      ) : (
        <div {...common}>{children}</div>
      )}
    </div>
  );
}
