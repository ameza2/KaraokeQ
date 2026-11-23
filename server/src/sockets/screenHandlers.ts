import { browserLabel } from "./browser.ts";
import type { SocketContext } from "./context.ts";

/** The screen page: joining as the room's output, progress and player events. */
export function screenHandlers({ socket, rooms, room, leave }: SocketContext) {
  socket.on("screen:progress", (p) => {
    if (socket.data.isScreen && room()?.mode === "screen") room()?.reportProgress(p);
  });

  socket.on("screen:join", async ({ code, deviceId, host }, ack) => {
    const r = rooms.get(code);
    if (!r) return ack({ ok: false, error: "That room doesn't exist (or has expired)." });
    if (socket.data.code && socket.data.code !== r.code) leave();
    r.replaceScreens(socket.id, "screen");

    const h = String(host ?? "");
    // raw IP or localhost: YouTube blocks many videos for pages opened at these
    const rawAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[") || h === "localhost" || h.endsWith(".localhost");
    socket.data = { code: r.code, isScreen: true, ipAddress: rawAddress, host: h || "?" };
    console.log(`[${r.code}] screen joined: ${h || "?"} (${browserLabel(String(socket.handshake.headers["user-agent"] ?? ""))})`);
    socket.join([r.channel, `screen:${r.code}`]);
    r.screens.add(socket.id);
    // the device showing this screen gets the host's permissions (until another screen takes over)
    r.screenSinger = deviceId ? String(deviceId).slice(0, 64) : null;
    ack({ ok: true, state: r.state() });
    // Pick up exactly where playback was (timestamp + paused state).
    if (r.mode === "screen") socket.emit("screen:command", r.resumeCommand());
    r.broadcast();
  });

  socket.on("screen:event", (e) => {
    const r = room();
    if (r && socket.data.isScreen && r.mode === "screen")
      r.screenOutput.handleEvent(e, {
        socketId: socket.id,
        ipAddress: !!socket.data.ipAddress,
        host: socket.data.host ?? "?",
        browser: browserLabel(String(socket.handshake.headers["user-agent"] ?? "")),
      });
  });
}
