import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

/** This machine's IPv4 addresses on the local network. */
export function lanIps(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n!.address);
}

const preferredIp = (ips: string[]) => ips.find((i) => i.startsWith("192.168.")) ?? ips.find((i) => i.startsWith("10.")) ?? ips[0];

/**
 * A hostname other devices can use to reach this machine.
 *
 * Why: YouTube refuses many videos (music labels especially, error 150) when the
 * embedding page is a raw IP address like http://192.168.0.5:5173, but plays
 * them on a hostname pointing to the same machine. Phones and TVs can't resolve
 * this PC's name without setup, so we use a public wildcard DNS name that
 * resolves to the LAN IP (192-168-0-5.nip.io → 192.168.0.5). Only the private
 * LAN IP is part of the DNS query.
 *
 * Override with KARAOKE_HOST (e.g. a name on your router). null = none works.
 */
let shareHost: string | null = process.env.KARAOKE_HOST?.trim() || null;
export const getShareHost = () => shareHost;

async function refresh() {
  if (process.env.KARAOKE_HOST?.trim()) return;
  const ip = preferredIp(lanIps());
  if (!ip) return void (shareHost = null);
  const dashed = ip.replaceAll(".", "-");
  for (const h of [`${dashed}.nip.io`, `${dashed}.sslip.io`]) {
    try {
      const { address } = await lookup(h, { family: 4 });
      if (address === ip) {
        if (shareHost !== h) console.log(`sharing as http://${h} (YouTube blocks many videos on raw-IP pages)`);
        shareHost = h;
        return;
      }
    } catch {
      /* no internet / DNS rebind protection on the router: try the next one */
    }
  }
  if (shareHost) console.log("no shareable hostname resolves any more; falling back to the LAN IP");
  shareHost = null;
}

export function startShareHostWatch() {
  void refresh();
  setInterval(refresh, 10 * 60e3).unref(); // the LAN IP can change (DHCP)
}
