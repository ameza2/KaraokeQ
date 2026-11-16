import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, createRoom, startServer, until, video, wait, type TestServer } from "./harness.ts";

let server: TestServer;
const clients: Client[] = [];
before(async () => {
  server = await startServer();
});
after(async () => {
  clients.forEach((c) => c.close());
  await server.stop();
});

/** A room with a host, and a screen opened at `screenHost`. */
async function room(screenHost: string) {
  const { code, hostToken } = await createRoom(server.url);
  const host = new Client(server.url, `h-${code}`);
  const tv = new Client(server.url, `tv-${code}`);
  clients.push(host, tv);
  await host.join(code, hostToken);
  await tv.joinScreen(code, screenHost);
  return { code, host, tv };
}

const playerError = (tv: Client, itemId: string, errorCode = 150, played = false) =>
  tv.emit("screen:event", { type: "error", itemId, errorCode, played });

describe("embed blocks (error 150)", () => {
  it("skips a video the uploader blocks, when the screen has a real hostname", async () => {
    const { host, tv } = await room("karaoke.example.com");
    await host.add(video("blocked"));
    const next = video("next");
    await host.add(next);
    const s = await host.waitState((s) => !!s.nowPlaying && s.queue.length === 1);
    playerError(tv, s.nowPlaying!.id);
    await host.waitState((s) => s.nowPlaying?.videoId === next.videoId, "the next song to start");
    assert.ok(host.notices.some((n) => n.includes("only plays on YouTube")));
  });

  it("holds the song instead of skipping when the screen is on a raw IP address", async () => {
    const { host, tv } = await room("192.168.1.20");
    await host.add(video("blocked"));
    await host.add(video("next"));
    const s = await host.waitState((s) => !!s.nowPlaying && s.queue.length === 1);
    playerError(tv, s.nowPlaying!.id);
    await until(() => tv.blocked[0], "a screen:blocked message");
    assert.equal(tv.blocked[0].reason, "ip");
    await wait(150);
    assert.equal(host.state.nowPlaying!.id, s.nowPlaying!.id); // still on stage
  });

  it("holds when two different songs in a row fail on the same screen", async () => {
    const { host, tv } = await room("karaoke.example.com");
    await host.add(video("one"));
    await host.add(video("two"));
    const first = await host.waitState((s) => !!s.nowPlaying && s.queue.length === 1);
    const firstId = first.nowPlaying!.id;
    playerError(tv, firstId);
    const second = await host.waitState((s) => !!s.nowPlaying && s.nowPlaying.id !== firstId, "second song");
    playerError(tv, second.nowPlaying!.id);
    await until(() => tv.blocked[0], "a hold on the second failure");
    assert.equal(tv.blocked[0].reason, "device");
  });

  it("treats an error after the video started playing as a plan limit, not a block", async () => {
    const { host, tv } = await room("karaoke.example.com");
    await host.add(video("limit"));
    await host.add(video("next"));
    const s = await host.waitState((s) => !!s.nowPlaying && s.queue.length === 1);
    playerError(tv, s.nowPlaying!.id, 150, true);
    await until(() => tv.blocked[0], "a screen:blocked message");
    assert.equal(tv.blocked[0].reason, "limit");
    assert.equal(host.state.nowPlaying!.id, s.nowPlaying!.id);
  });

  it("lets a person skip a held song from the screen", async () => {
    const { host, tv } = await room("10.0.0.5");
    await host.add(video("held"));
    const next = video("after");
    await host.add(next);
    const s = await host.waitState((s) => !!s.nowPlaying && s.queue.length === 1);
    playerError(tv, s.nowPlaying!.id);
    await until(() => tv.blocked[0], "hold");
    tv.emit("screen:event", { type: "skip-blocked", itemId: s.nowPlaying!.id });
    await host.waitState((s) => s.nowPlaying?.videoId === next.videoId);
  });
});
