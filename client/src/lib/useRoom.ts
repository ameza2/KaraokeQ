import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice, Progress, RoomState } from "@karaoke/shared";

export interface TimedProgress extends Progress {
  at: number; // performance.now() when received
}
import { connect, type KSocket } from "./socket.ts";
import { getHostToken, screenDeviceId, setHostToken, singerId } from "./storage.ts";

export interface Toast extends Notice {
  id: number;
}

/** Connects to a room as a guest (or host, if this device holds the host token). */
export function useRoom(code: string, name: string | null, asScreen = false) {
  const me = asScreen ? screenDeviceId() : singerId();
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // last reported position + local receive time (for interpolation)
  const [progress, setProgress] = useState<TimedProgress | null>(null);
  const socketRef = useRef<KSocket | null>(null);

  const toast = useCallback((n: Notice) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { ...n, id }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), n.level === "error" ? 6000 : 3500);
  }, []);

  useEffect(() => {
    if (!name) return;
    const socket = connect();
    socketRef.current = socket;

    const join = () =>
      socket.emit("room:join", { code, singerId: me, name, hostToken: asScreen ? undefined : getHostToken(code), asScreen }, (r) => {
        if (!r.ok) return setError(r.error);
        setError(null);
        setState(r.state);
        if (r.hostToken) setHostToken(code, r.hostToken); // claimed host of a TV-created room
      });

    socket.on("connect", () => {
      setConnected(true);
      join(); // also re-joins after a reconnect
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("room:state", setState);
    socket.on("notice", toast);
    // made host by the previous host: keep the proof so reloads stay host
    socket.on("host:token", ({ hostToken }) => setHostToken(code, hostToken));
    socket.on("playback:progress", (p) => setProgress({ ...p, at: performance.now() }));
    // the admin deleted the room: the server hangs up next, and we don't come back
    socket.on("room:closed", ({ message }) => setError(message));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [code, name, toast, asScreen]);

  // Host is a person, tracked by the server: hand-overs show up on every device at once.
  const isHost = !!state && state.hostId === me;
  // the room's screen device gets the host's permissions
  // The device that is currently the room's screen is a "superhost": it keeps host
  // controls even after handing host to someone else (both in screen mode and when
  // a phone/laptop plays the videos itself).
  const isScreenDevice = !!state?.screenId && state.screenId === me;
  const hostPowers = isHost || isScreenDevice;
  const canControl = hostPowers || !!state?.settings.openControls;
  return { me, state, isHost, isScreenDevice, hostPowers, canControl, error, connected, toasts, toast, progress, setProgress, socket: socketRef };
}
