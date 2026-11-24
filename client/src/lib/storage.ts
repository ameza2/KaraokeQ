// localStorage wrappers that never throw (private mode, blocked storage, etc.).

export function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// crypto.randomUUID only exists on HTTPS/localhost; phones on http://192.168.x.x need this.
const memoryId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Stable per-device id so a guest keeps their songs across reloads. */
export function singerId(): string {
  let id = load("karaoke:singerId");
  if (!id) {
    id = memoryId;
    save("karaoke:singerId", id);
  }
  return id;
}

/**
 * Separate id for this browser when it acts as a room's screen, so a laptop used
 * both as a screen and as a singer (two tabs) shows up as two participants.
 */
export function screenDeviceId(): string {
  let id = load("karaoke:screenId");
  if (!id) {
    id = "screen-" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    save("karaoke:screenId", id);
  }
  return id;
}
export const getLastScreenRoom = () => load("karaoke:tvRoom") ?? "";
export const setLastScreenRoom = (code: string) => save("karaoke:tvRoom", code);

export const getName = () => load("karaoke:name") ?? "";
export const setName = (n: string) => save("karaoke:name", n);
export const getHostToken = (code: string) => load(`karaoke:host:${code}`) ?? undefined;
export const setHostToken = (code: string, t: string) => save(`karaoke:host:${code}`, t);
/** The code that lets this device be a room's screen (the server hands it to the first screen, the host reads it from the menu). */
export const getScreenCode = (code: string) => load(`karaoke:screencode:${code}`) ?? undefined;
export const setScreenCode = (code: string, v: string) => save(`karaoke:screencode:${code}`, v);
/** Rooms started from this phone also play the videos on this phone. */
export const isPlayerDevice = (code: string) => load(`karaoke:player:${code}`) === "1";
export const setPlayerDevice = (code: string, on: boolean) => save(`karaoke:player:${code}`, on ? "1" : "0");
