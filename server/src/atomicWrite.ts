import { rename, writeFile } from "node:fs/promises";

const chains = new Map<string, Promise<unknown>>();

/**
 * Replace a file's contents in one step (write a temp file, then rename it over the target).
 * Writes to the same file run one after another, so two overlapping saves can't share the
 * temp file and the last call always wins.
 */
export function writeFileAtomic(file: string, text: string, mode?: number): Promise<void> {
  const run = (chains.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
    await rename(tmp, file);
  });
  chains.set(file, run);
  return run;
}
