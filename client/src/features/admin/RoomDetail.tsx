import { useState, type ReactNode } from "react";
import { THEMES, THEME_LABELS, type AdminRoomReport, type RoomSettings, type QueueItem, type ThemeName } from "@karaoke/shared";
import { api, type Run } from "../../lib/adminApi.ts";
import { useLanHost } from "../../lib/joinUrl.ts";
import { setScreenCode } from "../../lib/storage.ts";
import { duration, clock, dateTime } from "./format.ts";

export function RoomDetail({ room, now, run, onChanged, onDelete }: { room: AdminRoomReport; now: number; run: Run; onChanged: () => Promise<void>; onDelete: () => void }) {
  const lanHost = useLanHost();
  const base = `${window.location.protocol}//${lanHost}/r/${room.code}`;
  const [allPlays, setAllPlays] = useState<QueueItem[] | null>(null);
  const people = room.singers.filter((s) => !s.screen);
  const [linkCode, setLinkCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const linkDigits = linkCode.replace(/\D/g, "").slice(0, 12);
  const pair = async () => {
    setPairing(true);
    const r = await run(() => api("POST", `/rooms/${room.code}/cast`, { code: linkDigits }), `${room.code}: YouTube cast paired`);
    setPairing(false);
    if (r) setLinkCode("");
    await onChanged();
  };
  const setSetting = async (patch: Partial<RoomSettings>, done: string) => {
    await run(() => api("PUT", `/rooms/${room.code}/settings`, patch), `${room.code}: ${done}`);
    await onChanged();
  };

  return (
    <div className="admin-room-body">
      <dl className="admin-facts">
        <Fact label="Running time" value={duration(now - room.createdAt)} />
        <Fact label="Created" value={dateTime(room.createdAt)} />
        <Fact label="Last activity" value={`${duration(now - room.lastActive)} ago`} />
        <Fact label="Songs played" value={String(room.playCount)} />
        <Fact label="Screen" value={room.screenConnected ? `Connected${room.screenHost ? ` (${room.screenHost})` : ""}` : "Not connected"} />
        <Fact label="YouTube cast" value={room.cast ? `${room.cast.name} (${room.cast.connected ? "connected" : "reconnecting"})` : "Not paired"} />
      </dl>

      <h3>Screen</h3>
      <div className="admin-actions">
        <span className="admin-grow">
          Screen code <code>{room.screenCode}</code>
          <span className="muted small"> · {room.screenConnected ? "a screen is playing" : "no screen connected"}</span>
        </span>
        <button
          className="btn small"
          title="Only screens that join from now on need the new code"
          onClick={async () => {
            await run(() => api("POST", `/rooms/${room.code}/screen-code`), `${room.code}: new screen code`);
            await onChanged();
          }}
        >
          Reset code
        </button>
        {room.screenConnected && (
          <button
            className="btn small danger"
            onClick={async () => {
              await run(() => api("DELETE", `/rooms/${room.code}/screen`), `${room.code}: screen stopped`);
              await onChanged();
            }}
          >
            Stop screen
          </button>
        )}
      </div>

      <h3>YouTube cast</h3>
      {room.cast ? (
        <div className="admin-actions">
          <span className="admin-grow">
            <span className={`dot ${room.cast.connected ? "on" : ""}`} title={room.cast.connected ? "Connected" : "Reconnecting"} /> {room.cast.name}
            <span className="muted small"> · {room.cast.connected ? "connected" : "reconnecting…"}</span>
          </span>
          <button
            className="btn small"
            onClick={async () => {
              await run(() => api("DELETE", `/rooms/${room.code}/cast`), `${room.code}: stopped casting`);
              await onChanged();
            }}
          >
            Stop casting
          </button>
        </div>
      ) : (
        <form
          className="admin-actions"
          onSubmit={(e) => {
            e.preventDefault();
            if (linkDigits.length === 12 && !pairing) void pair();
          }}
        >
          <input
            className="input"
            inputMode="numeric"
            autoComplete="off"
            placeholder="TV's Link with TV code"
            aria-label="Link code"
            value={linkDigits.replace(/(\d{3})(?=\d)/g, "$1 ")}
            onChange={(e) => setLinkCode(e.target.value)}
          />
          <button className="btn small" disabled={linkDigits.length !== 12 || pairing}>
            {pairing ? "Connecting…" : "Pair"}
          </button>
        </form>
      )}

      <h3>Settings</h3>
      <div className="admin-settings">
        <label className="check">
          <input type="checkbox" checked={room.settings.openControls} onChange={(e) => void setSetting({ openControls: e.target.checked }, `Everyone can control ${e.target.checked ? "on" : "off"}`)} />
          <span>
            Everyone can control
            <span className="muted small">Any singer can skip, go back, seek and reorder</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={room.settings.fairQueue} onChange={(e) => void setSetting({ fairQueue: e.target.checked }, `Fair queue ${e.target.checked ? "on" : "off"}`)} />
          <span>
            Fair queue
            <span className="muted small">Singers with fewer songs queued go first</span>
          </span>
        </label>
        <label className="check colour">
          <span>
            Room colour
            <span className="muted small">Also set by the host in the room's menu</span>
          </span>
          <select value={room.settings.theme} onChange={(e) => void setSetting({ theme: e.target.value as ThemeName }, `Colour set to ${THEME_LABELS[e.target.value as ThemeName]}`)}>
            {THEMES.map((t) => (
              <option key={t} value={t}>
                {THEME_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3>Now playing</h3>
      {room.nowPlaying ? (
        <p className="admin-line">
          <b>{room.nowPlaying.title}</b>
          <span className="muted small">
            {room.nowPlaying.singerName}
            {room.paused ? " · paused" : ""}
          </span>
        </p>
      ) : (
        <p className="muted small">Nothing is playing.</p>
      )}

      <h3>
        Users <span className="muted small">({people.filter((s) => s.online).length} online of {people.length})</span>
      </h3>
      {people.length === 0 ? (
        <p className="muted small">Nobody has joined yet. The first person to join becomes the host.</p>
      ) : (
        <ul className="admin-list">
          {people.map((s) => (
            <li key={s.id}>
              <span className={`dot ${s.online ? "on" : ""}`} title={s.online ? "Online" : "Offline"} />
              <span className="admin-grow">
                {s.name}
                {!s.online && <span className="muted small"> · offline</span>}
              </span>
              {s.id === room.hostId ? (
                <span className="pill">Host</span>
              ) : (
                <button
                  className="btn small"
                  onClick={async () => {
                    await run(() => api("POST", `/rooms/${room.code}/host`, { singerId: s.id }), `${s.name} is now the host of ${room.code}`);
                    await onChanged();
                  }}
                >
                  Make host
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>
        Queue <span className="muted small">({room.queue.length})</span>
      </h3>
      {room.queue.length === 0 ? <p className="muted small">The queue is empty.</p> : <SongList items={room.queue} numbered />}

      <h3>
        Queue history{" "}
        <span className="muted small">
          ({allPlays ? `all ${allPlays.length}` : room.playCount > room.history.length ? `last ${room.history.length} of ${room.playCount}` : room.history.length}, newest first)
        </span>
      </h3>
      {room.history.length === 0 ? (
        <p className="muted small">No songs have been played yet.</p>
      ) : (
        <>
          <SongList items={allPlays ?? room.history} played />
          {!allPlays && room.playCount > room.history.length && (
            <button
              className="btn small"
              onClick={async () => {
                const r = await run(() => api<{ plays: (Omit<QueueItem, "id" | "thumb"> & { itemId: string })[] }>("GET", `/rooms/${room.code}/plays`));
                if (r) setAllPlays(r.plays.map((p) => ({ ...p, id: p.itemId })).reverse());
              }}
            >
              Show all {room.playCount}
            </button>
          )}
        </>
      )}

      <div className="admin-actions">
        <a className="btn small" href={base} target="_blank" rel="noreferrer">
          Open room
        </a>
        <a className="btn small" href={`${base}/screen`} target="_blank" rel="noreferrer" onClick={() => setScreenCode(room.code, room.screenCode)}>
          Open as screen
        </a>
        <button className="btn small danger" onClick={onDelete}>
          Delete room
        </button>
      </div>
    </div>
  );
}

const Fact = ({ label, value }: { label: string; value: ReactNode }) => (
  <div>
    <dt className="muted small">{label}</dt>
    <dd>{value}</dd>
  </div>
);

function SongList({ items, numbered, played }: { items: QueueItem[]; numbered?: boolean; played?: boolean }) {
  return (
    <ol className={`admin-list ${numbered ? "numbered" : ""}`}>
      {items.map((q, i) => (
        <li key={`${q.id}-${q.playedAt ?? ""}`}>
          {numbered && <span className="pos">{i + 1}</span>}
          <span className="admin-grow">
            {q.title}
            <span className="muted small"> · {q.singerName}</span>
          </span>
          {played && q.playedAt && <span className="muted small">{clock(q.playedAt)}</span>}
        </li>
      ))}
    </ol>
  );
}

// ---------- appearance ----------
