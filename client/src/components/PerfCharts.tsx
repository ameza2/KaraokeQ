import { useCallback, useEffect, useRef, useState } from "react";
import type { MetricHistory, MetricPoint } from "@karaoke/shared";
import { api, type Run } from "../lib/adminApi.ts";

/**
 * Server performance over time (admin debug page): one small line chart per
 * measure, sharing a time axis and a crosshair. The server keeps one sample a
 * minute for 7 days and returns them bucketed for the chosen range.
 */
const RANGES = [
  { hours: 1, label: "1 hour" },
  { hours: 6, label: "6 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

const MB = 1024 * 1024;

interface Measure {
  key: string;
  title: string;
  unit: string;
  value: (p: MetricPoint) => number;
  /** Highest value inside a bucket, when it differs from the plotted average. */
  peak?: (p: MetricPoint) => number;
  /** Extra detail for the tooltip. */
  detail?: (p: MetricPoint) => string;
  format: (v: number) => string;
  /** Whole numbers only on the axis (counts). */
  integer?: boolean;
}

const MEASURES: Measure[] = [
  { key: "cpu", title: "CPU", unit: "% of one core", value: (p) => p.cpu, peak: (p) => p.cpuMax, detail: (p) => `peak ${p.cpuMax.toFixed(1)}%`, format: (v) => `${v.toFixed(1)}%` },
  { key: "mem", title: "Memory", unit: "MB used by the server", value: (p) => p.rss / MB, detail: (p) => `heap ${(p.heap / MB).toFixed(0)} MB`, format: (v) => `${v.toFixed(0)} MB` },
  {
    key: "conn",
    title: "Connections",
    unit: "open connections",
    value: (p) => p.sockets,
    detail: (p) => `${p.singers} singer${p.singers === 1 ? "" : "s"} online`,
    format: (v) => String(Math.round(v)),
    integer: true,
  },
  { key: "rooms", title: "Rooms", unit: "live rooms", value: (p) => p.rooms, format: (v) => String(Math.round(v)), integer: true },
];

const timeLabel = (t: number, rangeHours: number) =>
  rangeHours <= 24
    ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
const fullTime = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A round axis maximum just above `max`. */
function niceMax(max: number, integer?: boolean) {
  if (max <= 0) return integer ? 4 : 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= max)! * pow;
  return integer ? Math.max(4, Math.ceil(step / 4) * 4) : step;
}

export default function PerfCharts({ run }: { run: Run }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<MetricHistory | null>(null);
  const [hover, setHover] = useState<number | null>(null); // index into data.points, shared by all charts
  const [table, setTable] = useState(false);

  const load = useCallback(async () => {
    const r = await run(() => api<MetricHistory>("GET", `/metrics?hours=${hours}`));
    if (r) setData(r);
  }, [run, hours]);
  useEffect(() => {
    setHover(null);
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60e3);
    return () => clearInterval(t);
  }, [load]);

  const points = data?.points ?? [];
  const covered = points.length ? (points[points.length - 1].at - points[0].at + (data?.bucketMs ?? 0)) / 3600e3 : 0;

  return (
    <div className="perf">
      <div className="admin-head">
        <div>
          <h2>Performance over time</h2>
          <p className="muted small">
            One sample a minute, kept for 7 days.
            {points.length > 0 && covered < hours * 0.95 && ` History so far: ${covered < 1 ? `${Math.max(1, Math.round(covered * 60))} min` : `${covered.toFixed(1)} h`}.`}
          </p>
        </div>
        <div className="seg" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.hours} role="radio" aria-checked={hours === r.hours} className={hours === r.hours ? "active" : ""} onClick={() => setHours(r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {!data ? (
        <p className="muted small">Loading…</p>
      ) : points.length < 2 ? (
        <p className="muted center pad">Collecting data. The first points appear a minute or two after the server starts.</p>
      ) : (
        <>
          <div className="perf-grid">
            {MEASURES.map((m) => (
              <LineChart key={m.key} measure={m} data={data} hours={hours} hover={hover} onHover={setHover} />
            ))}
          </div>
          <button className="link small" onClick={() => setTable((v) => !v)} aria-expanded={table}>
            {table ? "Hide the numbers" : "Show the numbers as a table"}
          </button>
          {table && (
            <div className="perf-table">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>CPU</th>
                    <th>CPU peak</th>
                    <th>Memory</th>
                    <th>Connections</th>
                    <th>Singers</th>
                    <th>Rooms</th>
                  </tr>
                </thead>
                <tbody>
                  {[...points].reverse().map((p) => (
                    <tr key={p.at}>
                      <td>{fullTime(p.at)}</td>
                      <td>{p.cpu.toFixed(1)}%</td>
                      <td>{p.cpuMax.toFixed(1)}%</td>
                      <td>{(p.rss / MB).toFixed(0)} MB</td>
                      <td>{p.sockets}</td>
                      <td>{p.singers}</td>
                      <td>{p.rooms}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const H = 150;
const PAD = { top: 8, right: 10, bottom: 20, left: 38 };

function LineChart({
  measure: m,
  data,
  hours,
  hover,
  onHover,
}: {
  measure: Measure;
  data: MetricHistory;
  hours: number;
  hover: number | null;
  onHover: (i: number | null) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const { points, from, to, bucketMs } = data;
  const values = points.map(m.value);
  const max = niceMax(Math.max(...values), m.integer);
  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - from) / (to - from)) * innerW;
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

  // One path per unbroken run: a gap wider than a couple of buckets means the server was off.
  const runs: number[][] = [];
  points.forEach((p, i) => {
    if (i > 0 && p.at - points[i - 1].at <= bucketMs * 2.5) runs[runs.length - 1].push(i);
    else runs.push([i]);
  });

  const latest = values[values.length - 1];
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const peak = Math.max(...points.map(m.peak ?? m.value));
  const hp = hover !== null ? points[hover] : null;
  const ticks = [0, max / 2, max];
  const xTicks = [from, from + (to - from) / 2, to];

  const move = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const t = from + ((clientX - rect.left - PAD.left) / innerW) * (to - from);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].at - t) < Math.abs(points[best].at - t)) best = i;
    onHover(best);
  };

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{m.title}</span>
        <span className="chart-now">{m.format(latest)}</span>
        <span className="muted small chart-unit">{m.unit}</span>
      </figcaption>
      <div
        className="chart-plot"
        ref={wrap}
        onPointerMove={(e) => move(e.clientX)}
        onPointerDown={(e) => move(e.clientX)}
        onPointerLeave={() => onHover(null)}
      >
        <svg width={width} height={H} role="img" aria-label={`${m.title} over the last ${hours} hours: latest ${m.format(latest)}, average ${m.format(avg)}, peak ${m.format(peak)}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="chart-axis" x={PAD.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle">
                {t === 0 || m.integer || t >= 10 ? Math.round(t) : t.toFixed(1)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={t} className="chart-axis" x={x(t)} y={H - 5} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>
              {i === 2 ? "now" : timeLabel(t, hours)}
            </text>
          ))}
          {runs.map((run) =>
            run.length === 1 ? (
              <circle key={run[0]} className="chart-dot" cx={x(points[run[0]].at)} cy={y(values[run[0]])} r={2} />
            ) : (
              <path key={run[0]} className="chart-line" d={run.map((i, k) => `${k ? "L" : "M"}${x(points[i].at).toFixed(1)},${y(values[i]).toFixed(1)}`).join("")} />
            ),
          )}
          {hp && (
            <>
              <line className="chart-cross" x1={x(hp.at)} x2={x(hp.at)} y1={PAD.top} y2={PAD.top + innerH} />
              <circle className="chart-mark" cx={x(hp.at)} cy={y(m.value(hp))} r={4} />
            </>
          )}
        </svg>
        {hp && (
          <div className={`chart-tip ${x(hp.at) > width / 2 ? "left" : ""}`} style={{ left: x(hp.at) }}>
            <b>{m.format(m.value(hp))}</b>
            {m.detail && <span className="muted">{m.detail(hp)}</span>}
            <span className="muted">{fullTime(hp.at)}</span>
          </div>
        )}
      </div>
      <p className="muted small chart-sum">
        average {m.format(avg)} · peak {m.format(peak)}
      </p>
    </figure>
  );
}
