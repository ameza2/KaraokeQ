import type { RequestHandler } from "express";

/**
 * Baseline response headers for every page and API call.
 * No CSP yet: the YouTube player needs its script, frame and image origins listed, and that
 * should be tested on a real screen before it is enforced.
 */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY"); // nobody frames the app, the admin page least of all
  // Same as the browser default, stated outright: YouTube embeds need a referrer to play.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
};

/** Admin responses carry the room list, logs and session state: never cache them. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};
