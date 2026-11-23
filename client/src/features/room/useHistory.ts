import { useEffect, useState, type RefObject } from "react";
import type { QueueItem } from "@karaoke/shared";
import type { KSocket } from "../../lib/socket.ts";

/**
 * The room history is not part of room:state (it would ride along on every update).
 * While the history sheet is open, fetch it, and fetch again when the server says it changed.
 * null = not loaded yet.
 */
export function useHistory(socket: RefObject<KSocket | null>, open: boolean, rev: number | undefined) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  useEffect(() => {
    if (!open) {
      setItems(null);
      return;
    }
    let alive = true;
    socket.current?.emit("history:get", (r) => {
      if (alive && r.ok) setItems(r.items);
    });
    return () => {
      alive = false;
    };
  }, [open, rev, socket]);
  return items;
}
