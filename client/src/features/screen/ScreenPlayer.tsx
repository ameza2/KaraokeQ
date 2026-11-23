import type { ReplacedBy } from "@karaoke/shared";

// Placeholder: the video player arrives in a later commit.
export interface PlayerHandle {
  takeBack: () => void;
}

export default function ScreenPlayer(_props: Record<string, unknown> & { onReplacedChange?: (replaced: boolean, by: ReplacedBy) => void }) {
  return null;
}
