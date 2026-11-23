import express, { type Express, type RequestHandler } from "express";
import { getShareHost } from "../net.ts";
import { rateLimiter } from "../search.ts";

/*
 * Content-Security-Policy, REPORT-ONLY for now: browsers log what the policy would have
 * blocked to /api/csp-report (the system log) but block nothing. After some real sessions
 * (phones, the TV screen, casting, fullscreen) with a clean log, switch ENFORCE on.
 * See CONTEXT.md §10 for the checklist.
 */
const ENFORCE = process.env.KARAOKE_CSP_ENFORCE === "1";

/**
 * Hostname services that resolve to the LAN address. The client checks the shareable
 * hostname with a cross-origin request (hostRedirect.ts), so connect-src must allow them.
 * Add a new service here (or set KARAOKE_HOST) when net.ts starts using another one.
 */
const SHARE_HOST_SUFFIXES = ["nip.io", "sslip.io"];

/** Where the YouTube player and thumbnails come from. */
const YOUTUBE = {
  script: ["https://www.youtube.com", "https://s.ytimg.com"],
  frame: ["https://www.youtube.com", "https://www.youtube-nocookie.com"],
  img: ["https://i.ytimg.com", "https://*.ytimg.com"],
};

/** The policy for a page served at `host` (the Host header, e.g. "192-168-1-5.nip.io:3001"). */
export function buildPolicy(host: string | undefined): string {
  const safeHost = host && /^[\w.:-]+$/.test(host) ? host : undefined; // only ever echo a plain host[:port]
  const shareHost = getShareHost();
  const connect = [
    "'self'",
    // Older Safari does not count ws:// as 'self': name the socket origin outright.
    ...(safeHost ? [`ws://${safeHost}`, `wss://${safeHost}`] : []),
    // A host without a port only matches the default port, so ask for any port.
    ...SHARE_HOST_SUFFIXES.map((s) => `*.${s}:*`),
    ...(shareHost ? [`${shareHost}:*`] : []),
  ];
  return [
    "default-src 'self'",
    `script-src 'self' ${YOUTUBE.script.join(" ")}`,
    `frame-src ${YOUTUBE.frame.join(" ")}`,
    `img-src 'self' data: ${YOUTUBE.img.join(" ")}`,
    "style-src 'self' 'unsafe-inline'", // React sets inline style attributes
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "report-uri /api/csp-report",
  ].join("; ");
}

export const cspHeader: RequestHandler = (req, res, next) => {
  res.setHeader(ENFORCE ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", buildPolicy(req.headers.host));
  next();
};

/** Receives violation reports and writes one short line each to the system log. */
export function cspReportRoute(app: Express) {
  const allow = rateLimiter(30, 60e3); // a broken page can fire reports in a loop
  const seen = new Set<string>(); // one log line per distinct violation until the server restarts
  const parse = express.json({ type: ["application/csp-report", "application/reports+json", "application/json"], limit: "10kb" });
  app.post("/api/csp-report", parse, (req, res) => {
    res.status(204).end(); // always the same answer, whatever was sent
    if (!allow(req.ip ?? "?")) return;
    const body = req.body as unknown;
    const first = Array.isArray(body) ? (body[0] as { body?: Record<string, unknown> } | undefined)?.body : (body as { "csp-report"?: Record<string, unknown> } | undefined)?.["csp-report"];
    if (!first || typeof first !== "object") return;
    const pick = (...keys: string[]) => keys.map((k) => first[k]).find((v) => typeof v === "string") as string | undefined;
    const directive = pick("effective-directive", "effectiveDirective", "violated-directive", "violatedDirective") ?? "?";
    const blocked = (pick("blocked-uri", "blockedURL", "blockedUri") ?? "?").slice(0, 200);
    const page = (pick("document-uri", "documentURL") ?? "?").replace(/[?#].*$/, "").slice(0, 200); // no query or hash
    const key = `${directive}|${blocked}|${page}`;
    if (seen.has(key) || seen.size > 500) return;
    seen.add(key);
    console.warn(`CSP ${ENFORCE ? "blocked" : "would block"} ${directive}: ${blocked} (page ${page})`);
  });
}
