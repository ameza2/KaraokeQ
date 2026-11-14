import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  DEFAULT_THEME,
  THEMES,
  THEME_LABELS,
  type AdminRoomReport,
  type RoomSettings,
  type AdminSession,
  type AdminStats,
  type LogLine,
  type QueueItem,
  type ThemeName,
} from "@karaoke/shared";
import { useTheme } from "../lib/theme.ts";
import { api, ApiError, type Run } from "../lib/adminApi.ts";
import PerfCharts from "../components/PerfCharts.tsx";
import { useLanHost } from "../lib/joinUrl.ts";

/** Re-run `load` every `ms` while mounted (and once right away). */
function usePolling(load: () => Promise<void>, ms: number, enabled = true) {
  const ref = useRef(load);
  ref.current = load;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = () => void ref.current().catch(() => {});
    tick();
    const t = setInterval(() => alive && document.visibilityState === "visible" && tick(), ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ms, enabled]);
}

// ---------- formatting ----------

function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
const mb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateTime = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// ---------- page ----------

type Tab = "rooms" | "appearance" | "debug" | "account";
const TABS: { id: Tab; label: string }[] = [
  { id: "rooms", label: "Rooms" },
  { id: "appearance", label: "Appearance" },
  { id: "debug", label: "Debug" },
  { id: "account", label: "Account" },
];

export default function Admin() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [tab, setTab] = useState<Tab>("rooms");
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null);

  const signedOut = useCallback(() => setSession((s) => ({ authenticated: false, adminTheme: s?.adminTheme ?? DEFAULT_THEME })), []);
  const refresh = useCallback(() => api<AdminSession>("GET", "/session").then(setSession, signedOut), [signedOut]);
  useTheme(session?.adminTheme, "admin"); // the admin pages' own colour preset
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    document.title = "Admin · Karaoke Queue";
    return () => void (document.title = "Karaoke Queue");
  }, []);

  const say = useCallback((text: string, error = false) => {
    setFlash({ text, error });
    setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), error ? 6000 : 3500);
  }, []);
  /** Run an admin action; a lost session drops back to the sign-in form. */
  const run = useCallback(
    async <T,>(action: () => Promise<T>, done?: string): Promise<T | undefined> => {
      try {
        const result = await action();
        if (done) say(done);
        return result;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) signedOut();
        else say((e as Error).message, true);
        return undefined;
      }
    },
    [say, signedOut],
  );

  if (!session) return <main className="home muted">Loading…</main>;
  if (!session.authenticated) return <SignIn onDone={setSession} />;
  if (session.mustChangePassword)
    return (
      <main className="home admin-auth">
        <div className="orb" aria-hidden="true" />
        <h1>Choose a new password</h1>
        <p className="muted">You signed in with the default password. Set your own before using the admin area.</p>
        <PasswordForm currentLabel="Default password" onDone={() => void refresh()} />
        <button className="link" onClick={() => void api("POST", "/logout").then(refresh)}>
          Sign out
        </button>
      </main>
    );

  return (
    <div className="app admin">
      <header className="topbar">
        <div>
          <div className="room-code">
            Admin <span className="pill">{session.username}</span>
          </div>
          <div className="muted small">Karaoke Queue</div>
        </div>
        <div className="topbar-actions">
          <Link className="btn small" to="/">
            Home
          </Link>
          <button className="btn small" onClick={() => void api("POST", "/logout").then(refresh)}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabs admin-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "rooms" && <RoomsTab run={run} />}
      {tab === "appearance" && <AppearanceTab run={run} theme={session.adminTheme} onChange={(adminTheme) => setSession({ ...session, adminTheme })} />}
      {tab === "debug" && <DebugTab run={run} />}
      {tab === "account" && (
        <section className="admin-panel">
          <h2>Change password</h2>
          <p className="muted small">
            Stored only as a salted hash in the server's data folder. Forgot it? Delete <code>data/admin/credentials.json</code> on the server and the login
            goes back to the default, which must then be changed again.
          </p>
          <PasswordForm currentLabel="Current password" onDone={() => say("Password changed")} />
        </section>
      )}

      {flash && (
        <div className="toasts" aria-live="polite">
          <div className={`toast ${flash.error ? "error" : "info"}`}>{flash.text}</div>
        </div>
      )}
    </div>
  );
}

// ---------- sign-in ----------

function SignIn({ onDone }: { onDone: (s: AdminSession) => void }) {
  const [username, setUsername] = useState("Administrator");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<AdminSession>("POST", "/login", { username, password }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home admin-auth">
      <div className="orb" aria-hidden="true" />
      <h1>Admin</h1>
      <p className="muted">Sign in to manage rooms, appearance and logs.</p>
      <form className="stack admin-form" onSubmit={submit}>
        <label className="field">
          <span className="muted small">Username</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span className="muted small">Password</span>
          <input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <Link className="link" to="/">
        Back home
      </Link>
    </main>
  );
}

function PasswordForm({ currentLabel, onDone }: { currentLabel: string; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) return setError("The two new passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/password", { current, next });
      setCurrent("");
      setNext("");
      setAgain("");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack admin-form" onSubmit={submit}>
      <label className="field">
        <span className="muted small">{currentLabel}</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        <span className="muted small">New password (8 characters or more)</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="field">
        <span className="muted small">New password again</span>
        <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      <button className="btn primary" disabled={busy || !current || !next || !again}>
        {busy ? "Saving…" : "Save password"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// ---------- rooms ----------

function RoomsTab({ run }: { run: Run }) {
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
        <div className="dialog-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}
    </section>
  );
}

type SortKey = "length" | "singers" | "online";
const people = (r: AdminRoomReport) => r.singers.filter((s) => !s.screen);
const SORTS: Record<SortKey, { label: string; value: (r: AdminRoomReport) => number; high: string; low: string }> = {
  // an older room has run longer, so "longest first" is the smallest createdAt
  length: { label: "Session length", value: (r) => -r.createdAt, high: "Longest first", low: "Shortest first" },
  singers: { label: "Singers", value: (r) => people(r).length, high: "Most first", low: "Fewest first" },
  online: { label: "Singers online", value: (r) => people(r).filter((s) => s.online).length, high: "Most first", low: "Fewest first" },
};

function RoomDetail({ room, now, run, onChanged, onDelete }: { room: AdminRoomReport; now: number; run: Run; onChanged: () => Promise<void>; onDelete: () => void }) {
  const lanHost = useLanHost();
  const base = `${window.location.protocol}//${lanHost}/r/${room.code}`;
  const [allPlays, setAllPlays] = useState<QueueItem[] | null>(null);
  const people = room.singers.filter((s) => !s.screen);
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
      </dl>

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
                if (r) setAllPlays(r.plays.map((p) => ({ ...p, id: p.itemId, thumb: "" })).reverse());
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
        <a className="btn small" href={`${base}/screen`} target="_blank" rel="noreferrer">
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

function AppearanceTab({ run, theme, onChange }: { run: Run; theme: ThemeName; onChange: (t: ThemeName) => void }) {
  return (
    <section className="admin-panel">
      <h2>Admin colour preset</h2>
      <p className="muted small">
        Changes the admin pages only, on every device you sign in from. Each room has its own colour: its host picks it in the room's menu, and you can set
        it per room on the Rooms tab.
      </p>
      <div className="theme-grid" role="radiogroup" aria-label="Colour preset">
        {THEMES.map((t) => (
          <button
            key={t}
            role="radio"
            aria-checked={theme === t}
            className={`theme-card ${theme === t ? "active" : ""}`}
            data-theme={t}
            onClick={async () => {
              const r = await run(() => api<{ theme: ThemeName }>("PUT", "/theme", { theme: t }), `${THEME_LABELS[t]} applied`);
              if (r) onChange(r.theme);
            }}
          >
            <span className="theme-swatch" aria-hidden="true" />
            <span className="theme-name">{THEME_LABELS[t]}</span>
            <span className="muted small">{theme === t ? "Current" : "Use this"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------- debug ----------

function DebugTab({ run }: { run: Run }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [scope, setScope] = useState("system"); // "system" or a room code
  const [level, setLevel] = useState<"all" | "warn" | "error">("all");
  const [limit, setLimit] = useState(200);
  const [auto, setAuto] = useState(true);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [logRooms, setLogRooms] = useState<{ all: string[]; live: string[] }>({ all: [], live: [] });
  const [day, setDay] = useState(""); // "" = latest lines; or one day's system log file
  const [days, setDays] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // keep the view pinned to the newest line unless the admin scrolled up

  usePolling(async () => {
    const s = await run(() => api<AdminStats>("GET", "/stats"));
    if (s) setStats(s);
  }, 3000);

  const loadLogs = useCallback(async () => {
    if (scope === "system") {
      const r = await run(() => api<{ lines: LogLine[]; days: string[]; rooms: string[]; live: string[] }>("GET", `/logs?limit=${limit}${day ? `&day=${day}` : ""}`));
      if (r) {
        setLines(r.lines);
        setDays(r.days);
        setLogRooms({ all: r.rooms, live: r.live });
      }
    } else {
      const r = await run(() => api<{ lines: LogLine[] }>("GET", `/logs/${scope}?limit=${limit}`));
      if (r) setLines(r.lines);
    }
  }, [run, scope, limit, day]);
  usePolling(loadLogs, 3000, auto);
  useEffect(() => void loadLogs(), [loadLogs]);
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, level]);

  const shown = lines.filter((l) => level === "all" || l.level === level || (level === "warn" && l.level === "error"));

  return (
    <section className="admin-panel">
      <h2>Server</h2>
      {stats ? (
        <div className="stat-grid">
          <Stat label="CPU" value={`${stats.cpuPercent.toFixed(1)}%`} hint={`of one core · ${stats.cpuCores} cores`} />
          <Stat label="Memory" value={mb(stats.memory.rss)} hint={`heap ${mb(stats.memory.heapUsed)} of ${mb(stats.memory.heapTotal)}`} />
          <Stat label="System memory" value={`${mb(stats.memory.systemTotal - stats.memory.systemFree)}`} hint={`of ${mb(stats.memory.systemTotal)} in use`} />
          <Stat label="Uptime" value={duration(stats.uptimeSec * 1000)} hint={`since ${dateTime(stats.startedAt)}`} />
          <Stat label="Connections" value={String(stats.sockets)} hint={`${stats.singersOnline} singer${stats.singersOnline === 1 ? "" : "s"} online`} />
          <Stat label="Rooms" value={String(stats.rooms)} hint="live right now" />
          <Stat label="Log files" value={mb(stats.logBytes)} hint="system: 30 days · rooms: 5 MB each" />
          <Stat label="Runtime" value={`Node ${stats.node.replace(/^v/, "")}`} hint={`${stats.platform} · pid ${stats.pid}`} />
        </div>
      ) : (
        <p className="muted small">Loading…</p>
      )}
      {stats && (
        <p className="muted small">
          Data folder: <code>{stats.dataDir}</code> (logs are in <code>logs/</code>, never in a database)
        </p>
      )}

      <PerfCharts run={run} />

      <div className="admin-head log-head">
        <h2>Logs</h2>
        <div className="log-controls">
          <label className="muted small">
            Source
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="system">System (everything)</option>
              {logRooms.all.map((c) => (
                <option key={c} value={c}>
                  Room {c}
                  {logRooms.live.includes(c) ? "" : " (closed)"}
                </option>
              ))}
            </select>
          </label>
          {scope === "system" && (
            <label className="muted small">
              Day
              <select value={day} onChange={(e) => setDay(e.target.value)}>
                <option value="">Latest</option>
                {days.map((d) => (
                  <option key={d} value={d}>
                    {new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="muted small">
            Level
            <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
              <option value="all">All</option>
              <option value="warn">Warnings + errors</option>
              <option value="error">Errors</option>
            </select>
          </label>
          <label className="muted small">
            Lines
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[100, 200, 500, 1000, 2000].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="muted small log-auto">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Live
          </label>
          {!auto && (
            <button className="btn small" onClick={() => void loadLogs()}>
              Refresh
            </button>
          )}
        </div>
      </div>
      <div
        className="log-view"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.length === 0 ? (
          <p className="muted small center pad">No log lines{level !== "all" ? " at this level" : ""}.</p>
        ) : (
          shown.map((l, i) => (
            <div key={`${l.at}-${i}`} className={`log-line ${l.level}`}>
              <span className="log-time" title={new Date(l.at).toLocaleString()}>
                {clock(l.at)}
              </span>
              <span className="log-level">{l.level}</span>
              <span className="log-msg">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

const Stat = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div className="stat">
    <div className="muted small">{label}</div>
    <div className="stat-value">{value}</div>
    {hint && <div className="muted small">{hint}</div>}
  </div>
);
