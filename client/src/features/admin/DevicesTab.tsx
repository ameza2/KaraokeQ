import { useEffect, useState } from "react";
import type { DeviceRecord, DevicesReport } from "@karaoke/shared";
import { api, type Run } from "../../lib/adminApi.ts";
import { usePolling } from "./usePolling.ts";
import { dateTime } from "./format.ts";

const SCOPES: Record<string, string> = { login: "admin sign-in", code: "room codes", screen: "screen codes", admin: "blocked by you" };
const minutesLeft = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))} min`;
const when = (iso: string) => (iso ? dateTime(Date.parse(iso)) : "?");

export function DevicesTab({ run }: { run: Run }) {
  const [report, setReport] = useState<DevicesReport | null>(null);
  const [q, setQ] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");

  const load = async () => {
    const r = await run(() => api<DevicesReport>("GET", `/devices?q=${encodeURIComponent(q.trim())}`));
    if (r) setReport(r);
  };
  usePolling(load, 3000);
  useEffect(() => void load(), [q]); // eslint-disable-line react-hooks/exhaustive-deps -- search as you type

  const block = async (a: string, why = "", done = `${a} is blocked`) => {
    await run(() => api("POST", "/blocklist", { address: a, note: why }), done);
    await load();
  };
  const unblock = async (a: string, done: string) => {
    await run(() => api("DELETE", `/blocklist/${encodeURIComponent(a)}`), done);
    await load();
  };
  const saveNote = async (a: string, text: string) => {
    await run(() => api("PUT", `/devices/${encodeURIComponent(a)}/note`, { note: text }), `Note saved for ${a}`);
    await load();
  };

  const mine = report?.yourAddress;
  const BlockButton = ({ a }: { a: string }) =>
    a === mine ? (
      <span className="muted small">this device</span>
    ) : (
      <button className="btn small danger" onClick={() => void block(a)}>
        Block
      </button>
    );

  return (
    <section className="admin-panel">
      <h2>Devices</h2>
      <p className="muted small">
        A device is its network address (a MAC address never reaches the server). Everything below is kept for good in <code>data/devices/</code>, one file per
        device. After 5 wrong guesses in a row (admin password, room code, screen code) a device is blocked for 5 minutes; after 10 it stays blocked until you
        unblock it here, or set its <code>status</code> to <code>"ok"</code> in its file.
      </p>

      <h3>Connected now</h3>
      {!report ? (
        <p className="muted small">Loading…</p>
      ) : report.active.length === 0 ? (
        <p className="muted small">Nobody is connected.</p>
      ) : (
        <ul className="admin-list">
          {report.active.map((d) => (
            <li key={d.address}>
              <span className="admin-grow">
                <code>{d.address}</code>
                <span className="muted small">
                  {" "}
                  · {d.people.length ? d.people.map((p) => `${p.name || "?"}${p.room ? ` in ${p.room}` : ""}${p.role === "screen" ? " (screen)" : p.role === "host" ? " (host)" : ""}`).join(", ") : "not in a room"} · since{" "}
                  {when(d.connectedSince)}
                </span>
              </span>
              <BlockButton a={d.address} />
            </li>
          ))}
        </ul>
      )}

      <h3>Blocked until you lift it</h3>
      {!report || report.blocked.length === 0 ? (
        <p className="muted small">No devices are blocked for good.</p>
      ) : (
        <ul className="admin-list">
          {report.blocked.map((e) => (
            <li key={e.address}>
              <span className="admin-grow">
                <code>{e.address}</code>
                <span className="muted small">
                  {" "}
                  · {SCOPES[e.blocked?.scope ?? ""] ?? e.blocked?.scope} · since {when(e.blocked?.at ?? "")}
                  {e.note ? ` · ${e.note}` : ""}
                </span>
              </span>
              <button className="btn small" onClick={() => void unblock(e.address, `${e.address} can try again`)}>
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Blocked for a few minutes</h3>
      {!report || report.temporary.length === 0 ? (
        <p className="muted small">No devices are in a timeout.</p>
      ) : (
        <ul className="admin-list">
          {report.temporary.map((t) => (
            <li key={`${t.scope}|${t.address}`}>
              <span className="admin-grow">
                <code>{t.address}</code>
                <span className="muted small">
                  {" "}
                  · {SCOPES[t.scope] ?? t.scope} · {t.fails} wrong in a row · {minutesLeft(t.retryAfterMs)} left
                </span>
              </span>
              <button className="btn small" onClick={() => void unblock(t.address, `Timeout for ${t.address} ended`)}>
                End timeout
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Block a device</h3>
      <form
        className="admin-actions"
        onSubmit={async (e) => {
          e.preventDefault();
          await block(address.trim(), note.trim());
          setAddress("");
          setNote("");
        }}
      >
        <input
          className="input"
          inputMode="decimal"
          autoComplete="off"
          placeholder={report ? `IP address, e.g. 192.168.1.20 (this device: ${report.yourAddress})` : "IP address"}
          aria-label="IP address to block"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <input className="input" autoComplete="off" placeholder="Note (optional)" aria-label="Note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn small" type="submit" disabled={!address.trim()}>
          Block
        </button>
      </form>

      <h3>
        Every device seen <span className="muted small">({report?.total ?? 0} on record)</span>
      </h3>
      <input className="input" type="search" placeholder="Search by address, name, room code or note" aria-label="Search devices" value={q} onChange={(e) => setQ(e.target.value)} />
      {report && report.recent.length === 0 && <p className="muted small">No devices match.</p>}
      <ul className="admin-list">
        {report?.recent.map((d) => (
          <DeviceRow key={d.address} d={d} mine={d.address === mine} onBlock={() => void block(d.address)} onUnblock={() => void unblock(d.address, `${d.address} can try again`)} onNote={(t) => void saveNote(d.address, t)} />
        ))}
      </ul>
      <p className="muted small">The 50 most recent are shown. Search to find an older one.</p>
    </section>
  );
}

function DeviceRow({ d, mine, onBlock, onUnblock, onNote }: { d: DeviceRecord; mine: boolean; onBlock: () => void; onUnblock: () => void; onNote: (note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(d.note);
  const wrong = Object.values(d.failures).reduce((a, b) => a + b, 0);
  return (
    <li style={{ display: "block" }}>
      <div className="admin-actions">
        <button className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Details"}
        </button>
        <span className="admin-grow">
          <code>{d.address}</code>
          <span className="muted small">
            {" "}
            · last seen {when(d.lastSeen)} · {d.names.length ? d.names.map((n) => n.name).slice(-3).join(", ") : "no name yet"}
            {wrong ? ` · ${wrong} wrong guess${wrong === 1 ? "" : "es"}` : ""}
            {d.note ? ` · ${d.note}` : ""}
          </span>
        </span>
        {d.status === "blocked" ? (
          <button className="btn small" onClick={onUnblock}>
            Unblock
          </button>
        ) : mine ? (
          <span className="muted small">this device</span>
        ) : (
          <button className="btn small danger" onClick={onBlock}>
            Block
          </button>
        )}
      </div>
      {open && (
        <dl className="admin-facts">
          <div>
            <dt className="muted small">First seen</dt>
            <dd>{when(d.firstSeen)}</dd>
          </div>
          <div>
            <dt className="muted small">Connections</dt>
            <dd>{d.connections}</dd>
          </div>
          <div>
            <dt className="muted small">Wrong guesses</dt>
            <dd>{Object.entries(d.failures).map(([s, n]) => `${SCOPES[s] ?? s}: ${n}`).join(", ") || "none"}</dd>
          </div>
          <div>
            <dt className="muted small">Names used</dt>
            <dd>{d.names.map((n) => n.name).join(", ") || "none"}</dd>
          </div>
          <div>
            <dt className="muted small">Rooms</dt>
            <dd>{d.rooms.map((r) => `${r.code} (${r.role}, ${r.joins}×)`).join(", ") || "none"}</dd>
          </div>
          <div>
            <dt className="muted small">Browsers</dt>
            <dd className="small">{d.userAgents.map((u) => u.agent).join(" · ") || "none"}</dd>
          </div>
          <div>
            <dt className="muted small">Ban history</dt>
            <dd className="small">
              {d.bans.length === 0
                ? "none"
                : d.bans
                    .slice(-10)
                    .map((b) => `${b.kind === "permanent" ? "blocked" : "5 min"} (${SCOPES[b.scope] ?? b.scope}) ${when(b.at)}${b.liftedAt ? ` · lifted ${when(b.liftedAt)}` : ""}`)
                    .join("; ")}
            </dd>
          </div>
          <div>
            <dt className="muted small">Note</dt>
            <dd>
              <form
                className="admin-actions"
                onSubmit={(e) => {
                  e.preventDefault();
                  onNote(note.trim());
                }}
              >
                <input className="input" aria-label={`Note for ${d.address}`} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="btn small" type="submit" disabled={note.trim() === d.note}>
                  Save
                </button>
              </form>
            </dd>
          </div>
        </dl>
      )}
    </li>
  );
}
