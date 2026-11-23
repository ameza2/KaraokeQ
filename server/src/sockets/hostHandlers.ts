import type { SocketContext } from "./context.ts";

/** Host hand-over and claim, and room settings. */
export function hostHandlers({ socket, room, singerId, hostRoom }: SocketContext) {
  socket.on("host:transfer", ({ singerId: to }, ack) => {
    const r = hostRoom();
    if (!r) return ack({ ok: false, error: "Only the host can do that." });
    const target = r.singers.get(String(to));
    if (!target || target.screen || target.sockets.size === 0) return ack({ ok: false, error: "That person isn't connected right now." });
    // (when the screen moves host away from someone, assignHost tells them who has it now)
    if (!r.assignHost(target.id, singerId())) return ack({ ok: false, error: "Couldn't hand over host." });
    ack({ ok: true });
  });

  // Any singer, once the host has been away long enough.
  socket.on("host:claim", (ack) => {
    const r = room();
    const id = singerId();
    if (!r || !id) return ack({ ok: false, error: "Join the room first." });
    if (!r.claimHost(id)) return ack({ ok: false, error: "The host is connected, or hasn't been away long enough." });
    ack({ ok: true });
  });

  socket.on("settings:update", (patch) => hostRoom()?.updateSettings(patch ?? {}));
}
