import { Room } from "../rooms/index.ts";
import type { SocketContext } from "./context.ts";

/** Joining a room, renaming, leaving. */
export function roomHandlers({ socket, rooms, room, leave }: SocketContext) {
  socket.on("room:join", ({ code, singerId, name, hostToken, asScreen }, ack) => {
    const r = rooms.get(code);
    if (!r) return ack({ ok: false, error: "That room doesn't exist (or has expired)." });
    const cleanName = String(name ?? "").trim().slice(0, 24);
    if (!cleanName || !singerId) return ack({ ok: false, error: "Enter a name to join." });

    const id = String(singerId).slice(0, 64);
    if (!r.singers.has(id) && r.singers.size >= Room.MAX_SINGERS) return ack({ ok: false, error: "This room is full." });
    // one room per socket: leaving the old one keeps it from showing this person online forever
    if (socket.data.code && socket.data.code !== r.code) leave();
    // Host = whoever proves it with the current token, or the first person into a room
    // that has no host yet. A screen device never takes the host spot (it gets host powers instead).
    const screen = !!asScreen;
    const claimed = !screen && hostToken !== r.hostToken && !r.hostId;
    if (!screen && (hostToken === r.hostToken || claimed)) r.hostId = id;
    const isHost = r.isHost(id);

    socket.data = { code: r.code, singerId: id };
    socket.join([r.channel, r.singerChannel(id)]);
    if (!r.singers.get(id)?.sockets.size) r.say(`${screen ? "screen device" : "singer"} joined: ${cleanName}${isHost ? " (host)" : ""}`);
    r.upsertSinger(id, cleanName, socket.id, screen);
    ack({ ok: true, state: r.state(), isHost, ...(claimed ? { hostToken: r.hostToken } : {}) });
    if (claimed) socket.emit("notice", { level: "info", message: "You're the host of this room." });
    if (r.progress) socket.emit("playback:progress", r.progress);
    r.broadcast();
  });

  socket.on("singer:rename", ({ name }) => {
    const r = room();
    const clean = String(name ?? "").trim().slice(0, 24);
    if (!r || !clean || !socket.data.singerId) return;
    r.upsertSinger(socket.data.singerId, clean, socket.id);
    r.broadcast();
  });

  socket.on("disconnect", () => {
    const r = room();
    if (!r) return;
    r.disconnect(socket.id);
    r.broadcast();
  });
}
