import { knownNotEmbeddable } from "../search.ts";
import type { SocketContext } from "./context.ts";

/** Adding, removing, reordering and replaying songs. */
export function queueHandlers({ socket, room, singerId, controlRoom }: SocketContext) {
  socket.on("queue:add", ({ video }, ack) => {
    const r = room();
    const me = singerId();
    if (!r || !me) return ack({ ok: false, error: "Not in a room." });
    if (!video?.videoId || !/^[\w-]{11}$/.test(video.videoId)) return ack({ ok: false, error: "Invalid video." });
    const safe = {
      videoId: video.videoId,
      title: String(video.title ?? "").slice(0, 200),
      channel: String(video.channel ?? "").slice(0, 100),
      duration: String(video.duration ?? "").slice(0, 12),
      thumb: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`,
    };
    if (r.mode === "screen" && knownNotEmbeddable(video.videoId))
      return ack({ ok: false, error: "The uploader blocks this video outside YouTube. Pick another version." });
    const err = r.add(safe, me);
    ack(err ? { ok: false, error: err } : { ok: true });
  });

  socket.on("queue:remove", ({ itemId }) => {
    const r = room();
    r?.remove(itemId, singerId() ?? "", r.canControl(singerId()));
  });

  socket.on("queue:move", ({ itemId, toIndex }) => {
    controlRoom()?.move(itemId, Number(toIndex));
  });

  socket.on("history:replay", ({ itemId }, ack) => {
    const r = room();
    const me = singerId();
    if (!r || !me) return ack({ ok: false, error: "Not in a room." });
    const h = r.history.find((x) => x.id === itemId);
    if (h && r.mode === "screen" && knownNotEmbeddable(h.videoId))
      return ack({ ok: false, error: "The uploader blocks this video outside YouTube." });
    const err = r.replay(String(itemId), me);
    ack(err ? { ok: false, error: err } : { ok: true });
  });
}
