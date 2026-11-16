import { qrSrc, useJoinUrl } from "../../lib/joinUrl.ts";
import { Sheet } from "../../components/ui/Sheet.tsx";

export function ShareSheet({ code, isHost, onClose }: { code: string; isHost: boolean; onClose: () => void }) {
  const url = useJoinUrl(code);
  const screenUrl = url.replace(/\/r\/\w+$/, `/r/${code}/screen`);
  return (
    <Sheet onClose={onClose}>
      <h2>Invite singers</h2>
      <img className="qr" src={qrSrc(url)} alt={`QR code for ${url}`} />
      <p className="big-code">{code}</p>
      <p className="muted small break">{url}</p>
      <div className="row">
        <button
          className="btn"
          onClick={() =>
            navigator.share ? navigator.share({ title: "Join my karaoke room", url }).catch(() => {}) : navigator.clipboard?.writeText(url)
          }
        >
          Share link
        </button>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
      {isHost && (
        <p className="muted small">
          Screen: open <span className="break">{screenUrl}</span> in the TV's browser.
        </p>
      )}
    </Sheet>
  );
}
