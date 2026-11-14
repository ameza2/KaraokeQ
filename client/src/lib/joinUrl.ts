import { useEffect, useState } from "react";

/** Raw IP address. */
export const isIpHost = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[");
const isLocalName = (h: string) => h === "localhost" || h.endsWith(".localhost");
/**
 * Addresses where YouTube refuses many videos (error 150): raw IPs and localhost
 * (real Chrome blocks label content on localhost too). Pages here move to the
 * server's shareable hostname.
 */
export const isRawAddress = (h: string) => isIpHost(h) || isLocalName(h);

export interface ServerInfo {
  lanIps: string[];
  shareHost: string | null; // e.g. 192-168-0-5.nip.io
}
let info: Promise<ServerInfo> | null = null;
export const getServerInfo = () =>
  (info ??= fetch("/api/info")
    .then((r) => r.json() as Promise<ServerInfo>)
    .catch((): ServerInfo => ({ lanIps: [], shareHost: null })));

const preferredIp = (ips: string[]) => ips.find((i) => i.startsWith("192.168.")) ?? ips.find((i) => i.startsWith("10.")) ?? ips[0];

/**
 * host[:port] other devices should open. Prefers the server's shareable hostname
 * over a raw IP (YouTube blocks many videos on raw-IP pages), and the LAN address
 * over localhost.
 */
export function useLanHost() {
  const { hostname, port } = window.location;
  const withPort = (h: string) => (port ? `${h}:${port}` : h);
  const [host, setHost] = useState(withPort(hostname));
  useEffect(() => {
    if (!isIpHost(hostname) && !isLocalName(hostname)) return; // already a proper name
    getServerInfo().then(({ lanIps, shareHost }) => {
      const h = shareHost ?? preferredIp(lanIps);
      if (h) setHost(withPort(h));
    });
  }, []);
  return host;
}

/** The URL guests open (and the QR codes encode). */
export function useJoinUrl(code: string) {
  return `${window.location.protocol}//${useLanHost()}/r/${code}`;
}

export const qrSrc = (url: string) => `/api/qr?url=${encodeURIComponent(url)}`;
