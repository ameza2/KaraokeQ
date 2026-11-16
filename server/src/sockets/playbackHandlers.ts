import type { SocketContext } from "./context.ts";

/** Skip, rewind, pause, resume and seek. */
export function playbackHandlers({ socket, room, singerId, controlRoom }: SocketContext) {
  socket.on("playback:skip", () => {
    const r = room();
    if (r?.canSkip(singerId() ?? "")) r.advance();
  });
  socket.on("playback:rewind", () => controlRoom()?.rewind());
  socket.on("playback:seek", ({ seconds }) => controlRoom()?.seek(Number(seconds)));

  // Anyone in the room can pause/resume (e.g. the singer needs a moment).
  socket.on("playback:pause", () => {
    if (singerId()) room()?.pause();
  });
  socket.on("playback:resume", () => {
    if (singerId()) room()?.resume();
  });
}
