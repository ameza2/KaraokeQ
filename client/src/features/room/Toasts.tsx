import { type Toast } from "../../lib/useRoom.ts";

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
