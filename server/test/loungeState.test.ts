import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { QueueItem } from "@karaoke/shared";
import { LoungeOutput } from "../src/playback/lounge.ts";

/** The parts of LoungeOutput the TV-state logic touches. The real object talks to a TV, so this one is built without a constructor. */
interface Probe {
  screen: { name: string; screenId: string };
  current: { item: QueueItem; started: boolean; startAt: number; pauseOnStart: boolean; sent: boolean; sentAt: number; time: number; duration: number } | null;
  ext: { videoId: string; started: boolean; time: number; duration: number } | null;
  tvVideoId: string;
  onState(name: string, data: Record<string, string>): void;
  on(event: string, fn: (...a: unknown[]) => void): unknown;
  stop(): Promise<void>;
}

const item = (videoId: string): QueueItem => ({ id: `id-${videoId}`, videoId, title: videoId, channel: "", duration: "", singerId: "s", singerName: "S", addedAt: 0 });

function lounge(current: Probe["current"] = null) {
  const l = Object.create(LoungeOutput.prototype) as Probe;
  l.screen = { name: "Test TV", screenId: "tv" };
  l.current = current;
  l.ext = null;
  l.tvVideoId = "";
  const events: [string, ...unknown[]][] = [];
  for (const e of ["progress", "ended", "idle", "external", "external-ended", "remote-state"]) l.on(e, (...a) => events.push([e, ...a]));
  return { l, events };
}
const playing = (videoId: string, started: boolean, sentAt = 0): NonNullable<Probe["current"]> => ({ item: item(videoId), started, startAt: 0, pauseOnStart: false, sent: true, sentAt, time: 0, duration: 0 });

describe("LoungeOutput: what the TV reports", () => {
  it("marks our song as started and reports its progress", () => {
    const { l, events } = lounge(playing("AAAAAAAAAAA", false));
    l.onState("nowPlaying", { videoId: "AAAAAAAAAAA", currentTime: "4", duration: "200" });
    l.onState("onStateChange", { state: "1", currentTime: "5", duration: "200" });
    assert.equal(l.current?.started, true);
    assert.deepEqual(events.at(-1), ["progress", { itemId: "id-AAAAAAAAAAA", time: 5, duration: 200 }]);
  });

  it("reports the end of our song once, and forgets it", () => {
    const { l, events } = lounge(playing("AAAAAAAAAAA", true));
    l.onState("nowPlaying", { videoId: "AAAAAAAAAAA" });
    l.onState("onStateChange", { state: "0" });
    assert.deepEqual(events.filter((e) => e[0] === "ended"), [["ended", "id-AAAAAAAAAAA"]]);
    assert.equal(l.current, null);
  });

  it("ignores reports about the old video while the TV is still switching to our song", () => {
    const { l, events } = lounge(playing("NEWNEWNEWNE", false, Date.now()));
    l.onState("nowPlaying", { videoId: "OLDOLDOLDOL" });
    l.onState("onStateChange", { state: "1", currentTime: "30" });
    assert.deepEqual(events, []);
    assert.equal(l.ext, null);
    assert.equal(l.current?.started, false);
  });

  it("treats a different video, well after we sent ours, as someone using the TV remote", () => {
    const { l, events } = lounge(playing("AAAAAAAAAAA", true, 0));
    l.onState("nowPlaying", { videoId: "REMOTEVIDEO", currentTime: "1" });
    assert.deepEqual(events.find((e) => e[0] === "external"), ["external", "REMOTEVIDEO", "id-AAAAAAAAAAA"]);
    assert.equal(l.current, null);
    assert.equal(l.ext?.videoId, "REMOTEVIDEO");
  });

  it("reports an external video ending", () => {
    const { l, events } = lounge(null);
    l.ext = { videoId: "REMOTEVIDEO", started: true, time: 0, duration: 0 };
    l.onState("nowPlaying", { videoId: "REMOTEVIDEO" });
    l.onState("onStateChange", { state: "0" });
    assert.ok(events.some((e) => e[0] === "external-ended"));
    assert.equal(l.ext, null);
  });

  it("mirrors a pause from the TV remote on a started song", () => {
    const { l, events } = lounge(playing("AAAAAAAAAAA", true));
    l.onState("nowPlaying", { videoId: "AAAAAAAAAAA" });
    l.onState("onStateChange", { state: "2", currentTime: "9" });
    assert.ok(events.some((e) => e[0] === "remote-state" && e[1] === "paused"));
  });
});
