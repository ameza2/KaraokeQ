import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

/** Unknown API paths get JSON; in production the built client is served for everything else. */
export function staticClient(app: Express) {
  // Must come after every API route.
  app.use("/api", (_req, res) => void res.status(404).json({ error: "Not found." }));

  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../client/dist");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
  }
}
