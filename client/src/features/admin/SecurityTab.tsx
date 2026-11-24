import { useState } from "react";
import type { BlocklistReport } from "@karaoke/shared";
import { api, type Run } from "../../lib/adminApi.ts";
import { usePolling } from "./usePolling.ts";
import { dateTime } from "./format.ts";

const SCOPES: Record<string, string> = { login: "admin sign-in", code: "room codes", screen: "screen codes", admin: "blocked by you" };
const minutesLeft = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))} min`;

export function SecurityTab({ run }: { run: Run }) {
  const [report, setReport] = useState<BlocklistReport | null>(null);
  const [address, setAddress] = useState("");

  usePolling(async () => {
    const r = await run(() => api<BlocklistReport>("GET", "/blocklist"));
    if (r) setReport(r);
  }, 3000);

  const unblock = async (a: string, done: string) => {
    const r = await run(() => api<BlocklistReport>("DELETE", `/blocklist/${encodeURIComponent(a)}`), done);
    if (r) setReport(r);
  };

  return (
    <section className="admin-panel">
      <h2>Blocked devices</h2>
      <p className="muted small">
        A device is its network address. After 5 wrong guesses in a row (admin password, room code, screen code) it is blocked for 5 minutes; after 10 it
        stays blocked until you lift it here. The list is also the file <code>data/blocklist.json</code>.
      </p>

      <h3>Blocked until you lift it</h3>
      {!report ? (
        <p className="muted small">Loading…</p>
      ) : report.permanent.length === 0 ? (
        <p className="muted small">No devices are blocked for good.</p>
      ) : (
        <ul className="admin-list">
          {report.permanent.map((e) => (
            <li key={e.address}>
              <span className="admin-grow">
                <code>{e.address}</code>
                <span className="muted small">
                  {" "}
                  · {SCOPES[e.scope] ?? e.scope} · since {e.since ? dateTime(Date.parse(e.since)) : "?"}
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
          const a = address.trim();
          const r = await run(() => api<BlocklistReport>("POST", "/blocklist", { address: a }), `${a} is blocked`);
          if (!r) return;
          setReport(r);
          setAddress("");
        }}
      >
        <input
          className="input"
          inputMode="decimal"
          autoComplete="off"
          placeholder={report ? `e.g. 192.168.1.20 (this device: ${report.yourAddress})` : "IP address"}
          aria-label="IP address to block"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button className="btn small" type="submit" disabled={!address.trim()}>
          Block
        </button>
      </form>
    </section>
  );
}
