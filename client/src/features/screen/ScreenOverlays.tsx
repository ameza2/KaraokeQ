import { useState } from "react";
import type { BlockReason, QueueItem, ReplacedBy } from "@karaoke/shared";
import { moveOffIpAddress } from "../../lib/hostRedirect.ts";
import { qrSrc } from "../../lib/joinUrl.ts";
import { takenOverText } from "./takeover.ts";

/** Presentational pieces of the screen player: they hold no playback state of their own. */

/** What the server said when it held a song (see screen:blocked). */
export interface BlockInfo {
  itemId: string;
  shareHost: string | null;
  reason: BlockReason;
}

/** Shown in place of the player once another screen or the YouTube cast has taken over. */
export function ReplacedNotice({ isScreen, by, code, onTakeBack }: { isScreen: boolean; by: ReplacedBy; code: string; onTakeBack: () => void }) {
  if (!isScreen)
    return (
      <div className="embed-note">
        <span className="muted">{takenOverText(by)}</span>
        <button className="btn small" onClick={onTakeBack}>
          Play here instead
        </button>
      </div>
    );
  return (
    <main className="screen-msg replaced">
      <div className="stack center" style={{ maxWidth: 520 }}>
        <div className="orb" aria-hidden="true" />
        <h2>{takenOverText(by)}</h2>
        <p className="muted">
          {by === "cast"
            ? `Room ${code} is now casting to the TV's YouTube app. Using this screen stops the cast.`
            : `Room ${code} is now playing on another screen. Only one screen can play at a time.`}
        </p>
        <button className="btn primary big" onClick={onTakeBack}>
          Use this screen instead
        </button>
      </div>
    </main>
  );
}

/** Asked for the room's screen code: the host reads it in the menu (Host & screen). */
export function ScreenCodePrompt({ isScreen, message, onSubmit }: { isScreen: boolean; message: string; onSubmit: (code: string) => void }) {
  const [value, setValue] = useState("");
  const form = (
    <form
      className="screen-code-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <input
        className="input code-input"
        placeholder="CODE"
        inputMode="text"
        aria-label="Screen code"
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
        maxLength={12}
        autoFocus
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
      />
      <button className="btn primary" type="submit" disabled={!value.trim()}>
        Use this screen
      </button>
    </form>
  );
  if (!isScreen)
    return (
      <div className="screen-code-card">
        <span>{message}</span>
        {form}
      </div>
    );
  return (
    <main className="screen-msg">
      <div className="stack center" style={{ maxWidth: 520 }}>
        <div className="orb" aria-hidden="true" />
        <h2>Enter the screen code</h2>
        <p className="muted">{message} The host finds it in the menu under Host &amp; screen.</p>
        {form}
      </div>
    </main>
  );
}

/** What the screen shows while nothing is playing. */
export function IdleScreen({ big, joinUrl, code, upNext }: { big: boolean; joinUrl: string; code: string; upNext: QueueItem[] }) {
  if (!big) return <div className="embed-idle muted">Songs play here. Queue one below.</div>;
  return (
    <div className="idle">
      <div className="idle-join">
        <img className="qr big" src={qrSrc(joinUrl)} alt="Scan to join" />
        <div>
          <div className="idle-title">Scan to queue a song</div>
          <div className="big-code">{code}</div>
          <div className="muted">{joinUrl}</div>
        </div>
      </div>
      {upNext.length > 0 ? <UpNext items={upNext} /> : <p className="muted">The queue is empty. Add a song from your phone.</p>}
    </div>
  );
}

function UpNext({ items }: { items: QueueItem[] }) {
  return (
    <div className="upnext">
      <h3>Up next</h3>
      <ol>
        {items.map((q) => (
          <li key={q.id}>
            <b>{q.singerName}</b> <span className="muted">— {q.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A held song: why YouTube refused it here, and what to do (reopen by name, or skip it). */
export function BlockedOverlay({ block, onSkip }: { block: BlockInfo; onSkip: () => void }) {
  const [reopenFailed, setReopenFailed] = useState(false); // this device can't reach the shareable hostname
  return (
    <div className="start-overlay ip-blocked" role="alert">
      {block.reason === "limit" ? (
        <>
          <div className="start-title">YouTube stopped this video while it was playing</div>
          <div className="muted">
            This usually means the Google account this screen is signed in to has reached its plan's device limit, for example when the same account is also casting to the TV. Try this screen signed out or in Incognito, or skip the song.
          </div>
        </>
      ) : block.reason === "device" ? (
        <>
          <div className="start-title">YouTube won't play this video on this device</div>
          <div className="muted">If another device was playing it, tap "play here instead" there to keep singing. Otherwise skip the song.</div>
        </>
      ) : (
        <>
          <div className="start-title">YouTube blocks this video at this address</div>
          <div className="muted">
            This screen is open at {window.location.host}, an address where YouTube blocks many videos. Opened by name, the same video plays, and the song continues where
            it stopped.
          </div>
        </>
      )}
      <div className="row">
        {block.reason === "ip" && block.shareHost && (
          <button
            className="btn primary"
            onClick={async () => {
              if (!(await moveOffIpAddress())) setReopenFailed(true);
            }}
          >
            Reopen at {block.shareHost}
          </button>
        )}
        <button className="btn" onClick={onSkip}>
          Skip song
        </button>
      </div>
      {reopenFailed && <p className="error small">This device can't reach {block.shareHost}. Skip the song, or ask the host to set KARAOKE_HOST.</p>}
    </div>
  );
}
