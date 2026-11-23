import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

const YEAR_S = 365 * 24 * 3600;

/** Unknown API paths get JSON; in production the built client is served for everything else. */
export function staticClient(app: Express) {
  // Must come after every API route.
  app.use("/api", (_req, res) => void res.status(404).json({ error: "Not found." }));

  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client/dist");
  if (existsSync(clientDist)) {
    app.use(
      express.static(clientDist, {
        // Vite names everything in /assets after its content, so those files never change:
        // cache them for good. index.html must be re-checked so a new build is picked up.
        setHeaders(res, file) {
          const hashed = file.split(path.sep).join("/").includes("/assets/");
          res.setHeader("Cache-Control", hashed ? `public, max-age=${YEAR_S}, immutable` : "no-cache");
        },
      }),
    );
    app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(clientDist, "index.html")));
  }
}
