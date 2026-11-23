import type { ErrorRequestHandler } from "express";

/**
 * The last middleware: anything a route throws (Express 5 forwards rejected async handlers too)
 * and body-parser failures (bad JSON, body too large) answer with JSON instead of Express's HTML
 * page. Client errors keep their status; everything else is logged and answered with a plain 500.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" ? err.status : 500;
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: status === 413 ? "That request is too large." : "That request was not understood." });
    return;
  }
  console.error(`${req.method} ${req.path} failed:`, err);
  res.status(500).json({ error: "Something went wrong." });
};
