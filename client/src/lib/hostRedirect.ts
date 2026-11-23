import { getServerInfo, isRawAddress } from "./joinUrl.ts";
import { getHostToken, getLastScreenRoom, getName, isPlayerDevice, load, save, setHostToken, setLastScreenRoom, setName, setPlayerDevice, singerId } from "./storage.ts";

/*
 * YouTube blocks many videos (error 150) when the page is a raw IP address or localhost, but
 * plays them on a hostname for the same machine. So a page opened by IP moves
 * itself to the server's shareable hostname. Storage is per address, so who you
 * are (singer id, name, host token, screen settings) travels in the URL hash.
 */

/** Returns true if the page is navigating away. */
export async function moveOffIpAddress(): Promise<boolean> {
  const { protocol, hostname, port, pathname, search } = window.location;
  if (!isRawAddress(hostname)) return false;
  const { shareHost } = await getServerInfo();
  if (!shareHost) return false;
  const base = `${protocol}//${shareHost}${port ? `:${port}` : ""}`;

  // Only move if this device can actually reach that name (some routers block it).
  const reachable = await Promise.race([
    fetch(`${base}/api/info`, { mode: "no-cors", cache: "no-store" }).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 2500)),
  ]);
  if (!reachable) return false;

  const carry: Record<string, string> = { s: singerId() };
  const name = getName();
  if (name) carry.n = name;
  const screenId = load("karaoke:screenId");
  if (screenId) carry.d = screenId;
  const last = getLastScreenRoom();
  if (last) carry.l = last;
  const room = pathname.match(/^\/r\/([A-Za-z0-9]{4})/)?.[1]?.toUpperCase();
  if (room) {
    carry.c = room;
    const token = getHostToken(room);
    if (token) carry.t = token;
    if (isPlayerDevice(room)) carry.p = "1";
  }
  window.location.replace(`${base}${pathname}${search}#k=${encodeURIComponent(JSON.stringify(carry))}`);
  return true;
}

/** On arrival: store what the previous address carried over, then clean the URL. */
export function adoptCarriedIdentity() {
  const m = window.location.hash.match(/^#k=(.+)$/);
  if (!m) return;
  try {
    const c = JSON.parse(decodeURIComponent(m[1])) as Record<string, string>;
    if (c.s) save("karaoke:singerId", c.s);
    if (c.n && !getName()) setName(c.n);
    if (c.d) save("karaoke:screenId", c.d);
    if (c.l && !getLastScreenRoom()) setLastScreenRoom(c.l);
    if (c.c && c.t) setHostToken(c.c, c.t);
    if (c.c && c.p) setPlayerDevice(c.c, true);
  } catch {
    /* ignore a mangled hash */
  }
  history.replaceState(null, "", window.location.pathname + window.location.search);
}
