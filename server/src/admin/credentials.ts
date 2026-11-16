import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../atomicWrite.ts";
import path from "node:path";

/**
 * The admin login.
 *
 * - No credential file → the defaults apply (Administrator / password) and the
 *   admin must choose a new password before doing anything else.
 * - Changing the password writes the file. Deleting the file resets the login to
 *   the defaults (the documented way to recover a lost password).
 * - The password is never stored: only a salted scrypt hash.
 *
 * Storage sits behind CredentialStore so a database can replace the file later.
 */
export const DEFAULT_USERNAME = "Administrator";
export const DEFAULT_PASSWORD = "password";
export const MIN_PASSWORD_LENGTH = 8;

export interface CredentialRecord {
  username: string;
  algo: "scrypt";
  /** scrypt cost parameters, stored so they can be raised later without breaking old hashes. */
  params: { N: number; r: number; p: number; keylen: number };
  salt: string; // hex
  hash: string; // hex
  updatedAt: number;
}

export interface CredentialStore {
  /** The saved record, or null when none exists (defaults apply). */
  load(): Promise<CredentialRecord | null>;
  save(record: CredentialRecord): Promise<void>;
}

/** `<data>/admin/credentials.json`, written atomically and readable only by the owner. */
export class FileCredentialStore implements CredentialStore {
  readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "admin", "credentials.json");
  }

  async load(): Promise<CredentialRecord | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return null; // no file: defaults
    }
    try {
      const r = JSON.parse(text) as CredentialRecord;
      if (r.algo !== "scrypt" || !r.salt || !r.hash || !r.username || !r.params) throw new Error("unexpected shape");
      return r;
    } catch (e) {
      // A damaged file must not silently re-open the default login.
      throw new Error(`Credential file is unreadable (${(e as Error).message}). Delete ${this.file} to reset the admin login.`);
    }
  }

  async save(record: CredentialRecord) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(record, null, 2) + "\n", 0o600);
  }
}

const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };

function derive(password: string, salt: Buffer, params: CredentialRecord["params"]): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class AdminAuth {
  constructor(private store: CredentialStore) {}

  /** null = wrong username or password. */
  async verify(username: string, password: string): Promise<{ username: string; mustChangePassword: boolean } | null> {
    const record = await this.store.load();
    if (!record) {
      // Same amount of work as a real check, so timing doesn't reveal which mode we're in.
      await derive(password, Buffer.alloc(16), PARAMS);
      const ok = sameText(username, DEFAULT_USERNAME) && sameText(password, DEFAULT_PASSWORD);
      return ok ? { username: DEFAULT_USERNAME, mustChangePassword: true } : null;
    }
    const key = await derive(password, Buffer.from(record.salt, "hex"), record.params);
    const expected = Buffer.from(record.hash, "hex");
    const ok = sameText(username, record.username) && key.length === expected.length && timingSafeEqual(key, expected);
    return ok ? { username: record.username, mustChangePassword: false } : null;
  }

  /** Why a new password is not acceptable, or null when it is. */
  static passwordProblem(next: string): string | null {
    if (typeof next !== "string" || next.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (next.length > 200) return "That password is too long.";
    if (next.toLowerCase() === DEFAULT_PASSWORD) return "Choose something other than the default password.";
    return null;
  }

  async setPassword(username: string, next: string) {
    const salt = randomBytes(16);
    const key = await derive(next, salt, PARAMS);
    await this.store.save({ username, algo: "scrypt", params: PARAMS, salt: salt.toString("hex"), hash: key.toString("hex"), updatedAt: Date.now() });
  }
}
