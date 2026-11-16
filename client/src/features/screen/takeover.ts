import type { ReplacedBy } from "@karaoke/shared";

export function takenOverText(by: ReplacedBy) {
  return by === "cast" ? "YouTube cast has taken over." : "Another screen has taken over.";
}
