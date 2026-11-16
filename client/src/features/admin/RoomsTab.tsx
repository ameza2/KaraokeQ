import { useCallback, useEffect, useState } from "react";
import { type AdminRoomReport } from "@karaoke/shared";
import { api, type Run } from "../../lib/adminApi.ts";
import Room from "../room/RoomPage.tsx";
import { usePolling } from "./usePolling.ts";
import { duration, clock } from "./format.ts";
import { RoomDetail } from "./RoomDetail.tsx";
import { Dialog } from "../../components/ui/Dialog.tsx";

export function RoomsTab({ run }: { run: Run }) {
  const [rooms, setRooms] = useState<AdminRoomReport[] | null>(null);
  const [skew, setSkew] = useState(0); // server clock minus this device's clock
  const [, setTick] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminRoomReport | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("length");
  const [desc, setDesc] = useState(true);

  const load = useCallback(async () => {
    const r = await run(() => api<{ now: number; rooms: AdminRoomReport[] }>("GET", "/rooms"));
    if (!r) return;
    setSkew(r.now - Date.now());
    setRooms(r.rooms);
  }, [run]);
  usePolling(load, 3000);
  // running times tick every second between refreshes
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now() + skew;
  // Search matches the room code, the host, anyone in the room, and song titles.
  const q = query.trim().toLowerCase();
  const visible = (rooms ?? [])
    .filter(
      (r) =>
        !q ||
        r.code.toLowerCase().includes(q) ||
        r.singers.some((x) => x.name.toLowerCase().includes(q)) ||
        [r.nowPlaying, ...r.queue].some((x) => x?.title.toLowerCase().includes(q)),
    )
    .sort((a, b) => (SORTS[sort].value(a) - SORTS[sort].value(b)) * (desc ? -1 : 1) || a.code.localeCompare(b.code));
  const online = rooms?.reduce((n, r) => n + r.singers.filter((s) => s.online && !s.screen).length, 0) ?? 0;

  return (
    <section className="admin-panel">
      <div className="admin-head">
        <div>
          <h2>Rooms</h2>
          <p className="muted small">{rooms ? `${rooms.length} room${rooms.length === 1 ? "" : "s"} · ${online} singer${online === 1 ? "" : "s"} online` : "Loading…"}</p>
        </div>
        <button
          className="btn primary small"
          onClick={async () => {
            const r = await run(() => api<{ room: AdminRoomReport }>("POST", "/rooms"));
            if (r) {
              setOpen(r.room.code);
              await load();
            }
          }}
        >
          + Add room
        </button>
      </div>

      {rooms && rooms.length > 0 && (
        <div className="room-tools">
          <input
            className="input"
            type="search"
            placeholder="Find a room: code, person or song"
            aria-label="Find a room"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="muted small">
            Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {(Object.keys(SORTS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORTS[k].label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn small" onClick={() => setDesc((d) => !d)} aria-label={desc ? "Sorted high to low. Switch to low to high" : "Sorted low to high. Switch to high to low"}>
            {desc ? SORTS[sort].high : SORTS[sort].low} {desc ? "↓" : "↑"}
          </button>
        </div>
      )}

      {rooms?.length === 0 && <p className="muted center pad">No rooms right now. Add one, or start a party from the home page.</p>}
      {rooms && rooms.length > 0 && visible.length === 0 && <p className="muted center pad">No rooms match "{query.trim()}".</p>}
      {q && visible.length > 0 && rooms && (
        <p className="muted small">
          Showing {visible.length} of {rooms.length} rooms
        </p>
      )}

      <ul className="admin-rooms">
        {visible.map((r) => (
          <li key={r.id} className={`admin-room ${open === r.code ? "open" : ""}`}>
            <button className="admin-room-head" aria-expanded={open === r.code} onClick={() => setOpen(open === r.code ? null : r.code)}>
              <span className="admin-room-code">{r.code}</span>
              <span className="admin-room-meta">
                <span>
                  <b>{duration(now - r.createdAt)}</b> running
                </span>
                <span className="muted small">
                  Host: {r.hostName ?? "nobody"} · {r.singers.filter((s) => s.online && !s.screen).length} of {r.singers.filter((s) => !s.screen).length} online ·{" "}
                  {r.queue.length} queued ·{" "}
                  {r.screenConnected ? "screen on" : "no screen"}
                </span>
              </span>
              <span className="admin-chevron" aria-hidden="true">
                {open === r.code ? "▾" : "▸"}
              </span>
            </button>
            {open === r.code && (
              <RoomDetail
                room={r}
                now={now}
                run={run}
                onChanged={load}
                onDelete={() => setConfirmDelete(r)}
              />
            )}
          </li>
        ))}
      </ul>

      {confirmDelete && (
        <Dialog onClose={() => setConfirmDelete(null)}>
          <h2>Delete room {confirmDelete.code}?</h2>
          <p className="muted small">
            Everyone in it is disconnected and its queue is lost ({confirmDelete.queue.length} queued,{" "}
            {confirmDelete.singers.filter((s) => s.online).length} connected). The play log and room log files are kept.
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                const code = confirmDelete.code;
                setConfirmDelete(null);
                await run(() => api("DELETE", `/rooms/${code}`), `Room ${code} deleted`);
                await load();
              }}
            >
              Delete room
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

type SortKey = "length" | "singers" | "online";

export const people = (r: AdminRoomReport) => r.singers.filter((s) => !s.screen);

const SORTS: Record<SortKey, { label: string; value: (r: AdminRoomReport) => number; high: string; low: string }> = {
  // an older room has run longer, so "longest first" is the smallest createdAt
  length: { label: "Session length", value: (r) => -r.createdAt, high: "Longest first", low: "Shortest first" },
  singers: { label: "Singers", value: (r) => people(r).length, high: "Most first", low: "Fewest first" },
  online: { label: "Singers online", value: (r) => people(r).filter((s) => s.online).length, high: "Most first", low: "Fewest first" },
};
