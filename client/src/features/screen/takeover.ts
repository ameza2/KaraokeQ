/** What replaced this screen: another screen, or the YouTube cast. */
export type ReplacedBy = "screen" | "cast";

export function takenOverText(by: ReplacedBy) {
  return by === "cast" ? "YouTube cast has taken over." : "Another screen has taken over.";
}
