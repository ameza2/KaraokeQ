import { THEMES, THEME_LABELS, type RoomState, type ThemeName } from "@karaoke/shared";
import Room from "./RoomPage.tsx";
import { type SheetName } from "./RoomView.tsx";
import { Sheet } from "../../components/ui/Sheet.tsx";
import { ToggleItem } from "../../components/ui/ToggleItem.tsx";

/** A titled group of menu items; groups are separated by a divider. */
function MenuSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="menu-section" role="group" aria-label={title}>
      <div className="menu-section-title">{title}</div>
      {children}
    </div>
  );
}

export function MenuSheet({
  isHost,
  screenMode,
  screenUrl,
  code,
  historyCount,
  openControls,
  onToggleOpenControls,
  fairQueue,
  onToggleFairQueue,
  theme,
  onTheme,
  cast,
  playHere,
  onTogglePlayHere,
  onOpen,
  onRename,
  onClose,
}: {
  isHost: boolean;
  screenMode: boolean;
  screenUrl: string; // on the shareable hostname, never localhost/IP (YouTube blocks many videos there)
  code: string;
  historyCount: number;
  openControls: boolean;
  onToggleOpenControls: () => void;
  fairQueue: boolean;
  onToggleFairQueue: () => void;
  theme: ThemeName;
  onTheme: (t: ThemeName) => void;
  cast: RoomState["cast"];
  playHere: boolean;
  onTogglePlayHere: () => void;
  onOpen: (s: SheetName) => void;
  onRename: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose} className="menu" role="menu">
      <h2>Menu</h2>

      <MenuSection title="Room">
        <button className="menu-item" role="menuitem" onClick={() => onOpen("history")}>
          <span className="menu-icon">🕘</span>
          <span className="menu-text">
            Room history
            <span className="muted small">{historyCount ? `${historyCount} song${historyCount > 1 ? "s" : ""} played` : "Nothing played yet"}</span>
          </span>
        </button>
        <button className="menu-item" role="menuitem" onClick={() => onOpen("share")}>
          <span className="menu-icon">📨</span>
          <span className="menu-text">
            Invite singers<span className="muted small">QR code and link</span>
          </span>
        </button>
        {!screenMode && (
          <button className="menu-item" role="menuitem" onClick={onRename}>
            <span className="menu-icon">✏️</span>
            <span className="menu-text">
              Change your name<span className="muted small">Updates your queued songs too</span>
            </span>
          </button>
        )}
      </MenuSection>

      {isHost && (
        <MenuSection title="Settings">
          <ToggleItem icon="🎛️" title="Everyone can control" on={openControls} onToggle={onToggleOpenControls} hint={openControls ? "On: anyone can skip, go back, seek and reorder" : "Off: only you can skip others, go back, seek and reorder"} />
          <ToggleItem icon="⚖️" title="Fair queue" on={fairQueue} onToggle={onToggleFairQueue} hint={fairQueue ? "On: singers with fewer songs queued go first" : "Off: songs play in the order they were added"} />
          <div className="menu-item menu-static" role="group" aria-label="Room colour">
            <span className="menu-icon">🎨</span>
            <span className="menu-text">
              Room colour
              <span className="muted small">{THEME_LABELS[theme]}, on every device in this room</span>
            </span>
            <span className="swatches" role="radiogroup" aria-label="Room colour">
              {THEMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={theme === t}
                  aria-label={THEME_LABELS[t]}
                  title={THEME_LABELS[t]}
                  className={`swatch${theme === t ? " active" : ""}`}
                  data-theme={t}
                  onClick={() => onTheme(t)}
                />
              ))}
            </span>
          </div>
        </MenuSection>
      )}

      {isHost && (
        <MenuSection title={screenMode ? "Host" : "Host & screen"}>
          <button className="menu-item" role="menuitem" onClick={() => onOpen("host")}>
            <span className="menu-icon">👑</span>
            <span className="menu-text">
              Make someone else host<span className="muted small">Hand the room over to another singer</span>
            </span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => onOpen("cast")}>
            <span className="menu-icon">📡</span>
            <span className="menu-text">
              Cast to YouTube
              <span className="muted small">
                {cast ? `${cast.name}: ${cast.connected ? "connected" : "reconnecting…"}` : "Pair with the TV's YouTube app; every video plays"}
              </span>
            </span>
          </button>
          {!screenMode && (
            <button className="menu-item" role="menuitem" onClick={onTogglePlayHere}>
              <span className="menu-icon">{playHere ? "■" : "▶"}</span>
              <span className="menu-text">
                {playHere ? "Stop playing on this device" : "Play on this device"}
                <span className="muted small">{playHere ? "Use another screen instead" : "This phone or laptop becomes the screen"}</span>
              </span>
            </button>
          )}
          {!screenMode && (
            <a className="menu-item" role="menuitem" href={screenUrl} target="_blank" rel="noreferrer" onClick={onClose}>
              <span className="menu-icon">📺</span>
              <span className="menu-text">
                Open the screen<span className="muted small">Replaces any screen already playing</span>
              </span>
            </a>
          )}
        </MenuSection>
      )}
      <button className="btn" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}
