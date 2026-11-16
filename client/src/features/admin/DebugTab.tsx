import { useCallback, useEffect, useRef, useState } from "react";
import { type AdminStats, type LogLine } from "@karaoke/shared";
import { api, type Run } from "../../lib/adminApi.ts";
import PerfCharts from "./PerfCharts.tsx";
import Room from "../room/RoomPage.tsx";
import { usePolling } from "./usePolling.ts";
import { duration, mb, clock, dateTime } from "./format.ts";

export function DebugTab({ run }: { run: Run }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [castVerbose, setCastVerbose] = useState<boolean | null>(null);
  useEffect(() => {
    void run(() => api<{ verbose: boolean }>("GET", "/cast-log")).then((r) => r && setCastVerbose(r.verbose));
  }, [run]);
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

      <label className="check">
        <input
          type="checkbox"
          checked={!!castVerbose}
          disabled={castVerbose === null}
          onChange={async (e) => {
            const verbose = e.target.checked;
            const r = await run(() => api<{ verbose: boolean }>("PUT", "/cast-log", { verbose }));
            if (r) setCastVerbose(r.verbose);
          }}
        />
        <span>
          Verbose YouTube cast log
          <span className="small"> Log every command sent to the TV and every event it reports (very chatty; for debugging).</span>
        </span>
      </label>

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
