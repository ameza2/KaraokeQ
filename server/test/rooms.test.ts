import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, createRoom, startServer, until, video, wait, type TestServer } from "./harness.ts";

let server: TestServer;
const clients: Client[] = [];
const newClient = (id: string) => {
  const c = new Client(server.url, id);
  clients.push(c);
  return c;
};

before(async () => {
  server = await startServer();
});
after(async () => {
  clients.forEach((c) => c.close());
  await server.stop();
});

/** A room with a host (the creator) and any number of guests, all joined. */
async function party(...guests: string[]) {
  const { code, hostToken } = await createRoom(server.url);
  const host = newClient(`host-${code}`);
  await host.join(code, hostToken);
  const others: Client[] = [];
  for (const g of guests) {
    const c = newClient(`${g}-${code}`);
    await c.join(code);
    others.push(c);
  }
  return { code, host, others };
}

describe("rooms and joining", () => {
  it("creates a room and reports it exists", async () => {
    const { code } = await createRoom(server.url);
    assert.match(code, /^[A-Z2-9]{4,}$/);
    const res = await fetch(`${server.url}/api/rooms/${code}`);
    assert.deepEqual(await res.json(), { exists: true });
    assert.deepEqual(await (await fetch(`${server.url}/api/rooms/NOPE`)).json(), { exists: false });
  });

  it("makes the creator host and refuses a missing name or room", async () => {
    const { code, hostToken } = await createRoom(server.url);
    const host = newClient("h1");
    const r = await host.join(code, hostToken);
    assert.ok(r.ok && host.isHost);
    const noRoom = await newClient("x").join("ZZZZ");
    assert.equal(noRoom.ok, false);
    const noName = await new Client(server.url, "anon", "  ").join(code);
    assert.equal(noName.ok, false);
  });

  it("gives host to the first person in a screen-created room", async () => {
    const { code, hostToken } = await createRoom(server.url, "screen");
    assert.equal(hostToken, undefined);
    const first = newClient("first");
    const second = newClient("second");
    const r1 = await first.join(code);
    const r2 = await second.join(code);
    assert.ok(r1.ok && first.isHost && first.hostToken);
    assert.ok(r2.ok && !second.isHost);
  });
});

describe("queue", () => {
  it("rejects invalid videos, duplicates and a sixth song", async () => {
    const { host } = await party();
    assert.equal((await host.add({ ...video(), videoId: "bad" })).ok, false);
    const v = video();
    assert.ok((await host.add(v)).ok); // goes on stage
    const dup = video();
    assert.ok((await host.add(dup)).ok);
    assert.equal((await host.add(dup)).ok, false);
    for (let i = 0; i < 4; i++) assert.ok((await host.add(video())).ok);
    const sixth = await host.add(video());
    assert.equal(sixth.ok, false);
  });

  it("puts the first song on stage and the rest in the queue", async () => {
    const { host } = await party();
    const a = video("a");
    const b = video("b");
    await host.add(a);
    await host.add(b);
    const s = await host.waitState((s) => s.queue.length === 1 && !!s.nowPlaying);
    assert.equal(s.nowPlaying!.videoId, a.videoId);
    assert.equal(s.queue[0].videoId, b.videoId);
  });

  it("orders round-robin with the fair queue on", async () => {
    const { host, others: [ben, cat] } = await party("ben", "cat");
    const stage = video("stage");
    await host.add(stage);
    const h1 = video("h1"), h2 = video("h2");
    await host.add(h1);
    await host.add(h2);
    const b1 = video("b1"), c1 = video("c1");
    await ben.add(b1);
    await cat.add(c1);
    const s = await host.waitState((s) => s.queue.length === 4);
    // the host is on stage, so their turn is used: ben and cat go before the host's next songs
    assert.deepEqual(s.queue.map((q) => q.title), ["Song b1", "Song c1", "Song h1", "Song h2"]);
  });

  it("is first-come-first-served with the fair queue off", async () => {
    const { host, others: [ben] } = await party("ben");
    host.emit("settings:update", { fairQueue: false });
    await host.waitState((s) => !s.settings.fairQueue);
    await host.add(video("stage"));
    await host.add(video("h1"));
    await host.add(video("h2"));
    await ben.add(video("b1"));
    const s = await host.waitState((s) => s.queue.length === 3);
    assert.deepEqual(s.queue.map((q) => q.title), ["Song h1", "Song h2", "Song b1"]);
  });

  it("lets anyone remove their own song but only host remove others", async () => {
    const { host, others: [ben, cat] } = await party("ben", "cat");
    await host.add(video("stage"));
    await ben.add(video("b1"));
    await cat.add(video("c1"));
    const s = await host.waitState((s) => s.queue.length === 2);
    const bensItem = s.queue.find((q) => q.singerName.startsWith("ben"))!;
    const catsItem = s.queue.find((q) => q.singerName.startsWith("cat"))!;
    cat.emit("queue:remove", { itemId: bensItem.id }); // not allowed
    await wait(150);
    assert.equal(host.state.queue.length, 2);
    ben.emit("queue:remove", { itemId: bensItem.id });
    await host.waitState((s) => s.queue.length === 1);
    host.emit("queue:remove", { itemId: catsItem.id });
    await host.waitState((s) => s.queue.length === 0);
  });

  it("reorders only for host powers (or when controls are open)", async () => {
    const { host, others: [ben] } = await party("ben");
    await host.add(video("stage"));
    await host.add(video("a"));
    await host.add(video("b"));
    const s = await host.waitState((s) => s.queue.length === 2);
    const [a, b] = s.queue;
    ben.emit("queue:move", { itemId: b.id, toIndex: 0 });
    await wait(150);
    assert.deepEqual(host.state.queue.map((q) => q.id), [a.id, b.id]);
    host.emit("queue:move", { itemId: b.id, toIndex: 0 });
    await host.waitState((s) => s.queue[0].id === b.id);
    host.emit("settings:update", { openControls: true });
    await host.waitState((s) => s.settings.openControls);
    ben.emit("queue:move", { itemId: a.id, toIndex: 0 });
    await host.waitState((s) => s.queue[0].id === a.id);
  });
});

describe("playback permissions", () => {
  it("lets the singer skip their own song, and refuses other guests", async () => {
    const { host, others: [ben, cat] } = await party("ben", "cat");
    await ben.add(video("bens"));
    await host.add(video("hosts"));
    await host.waitState((s) => s.nowPlaying?.singerName.startsWith("ben") === true);
    cat.emit("playback:skip");
    await wait(150);
    assert.ok(host.state.nowPlaying?.singerName.startsWith("ben"));
    ben.emit("playback:skip");
    await host.waitState((s) => s.nowPlaying?.singerName.startsWith("host") === true);
  });

  it("lets anyone pause and resume", async () => {
    const { host, others: [ben] } = await party("ben");
    await host.add(video());
    await host.waitState((s) => !!s.nowPlaying);
    ben.emit("playback:pause");
    await host.waitState((s) => s.paused);
    ben.emit("playback:resume");
    await host.waitState((s) => !s.paused);
  });

  it("keeps skip, rewind and seek for host powers", async () => {
    const { host, others: [ben] } = await party("ben");
    await host.add(video("a"));
    await host.add(video("b"));
    await host.waitState((s) => s.queue.length === 1);
    ben.emit("playback:skip");
    await wait(150);
    assert.equal(host.state.queue.length, 1);
    host.emit("playback:skip");
    await host.waitState((s) => s.queue.length === 0 && s.history.length === 1);
    host.emit("playback:rewind"); // < 5s in: goes back one song
    await host.waitState((s) => s.queue.length === 1 && s.history.length === 0);
  });
});

describe("host", () => {
  it("hands host over, rotates the token and tells both people", async () => {
    const { code, host, others: [ben] } = await party("ben");
    const oldToken = host.hostToken;
    const r = await host.ask("host:transfer", { singerId: ben.singerId });
    assert.ok(r.ok);
    await until(() => ben.hostToken, "new host token");
    await host.waitState((s) => s.hostId === ben.singerId);
    // an old host's saved token no longer proves anything
    const again = newClient("host-again");
    const j = await again.join(code, oldToken);
    assert.ok(j.ok && !again.isHost);
    // and a guest cannot hand host over
    const denied = await again.ask("host:transfer", { singerId: again.singerId });
    assert.equal(denied.ok, false);
  });

  it("lets a guest claim host only after the host has been away long enough", async () => {
    const { host, others: [ben] } = await party("ben");
    assert.equal((await ben.ask("host:claim")).ok, false);
    host.close();
    await ben.waitState((s) => s.hostClaimable, "host to become claimable"); // KARAOKE_HOST_AWAY_MS=700
    assert.ok((await ben.ask("host:claim")).ok);
    await ben.waitState((s) => s.hostId === ben.singerId);
  });

  it("keeps settings host-only and validates the theme", async () => {
    const { host, others: [ben] } = await party("ben");
    ben.emit("settings:update", { fairQueue: false });
    await wait(150);
    assert.equal(host.state.settings.fairQueue, true);
    host.emit("settings:update", { theme: "blue" });
    await host.waitState((s) => s.settings.theme === "blue");
    host.emit("settings:update", { theme: "plaid" as never });
    await wait(150);
    assert.equal(host.state.settings.theme, "blue");
  });
});

describe("screen", () => {
  it("gives the screen device host powers and lets a newer screen replace it", async () => {
    const { code, host } = await party();
    const tv1 = newClient("tv1");
    assert.ok((await tv1.joinScreen(code)).ok);
    await host.waitState((s) => s.screens === 1);
    // the screen device is a superhost: it can change settings
    await tv1.join(code, undefined, true);
    tv1.emit("settings:update", { fairQueue: false });
    await host.waitState((s) => !s.settings.fairQueue);

    const tv2 = newClient("tv2");
    assert.ok((await tv2.joinScreen(code)).ok);
    await until(() => tv1.replacedBy === "screen", "old screen told it was replaced");
    await host.waitState((s) => s.screens === 1 && s.screenId === "tv2");
  });

  it("sends the current song to a joining screen", async () => {
    const { code, host } = await party();
    const song = video();
    await host.add(song);
    const tv = newClient("tv");
    await tv.joinScreen(code);
    await until(() => tv.commands.length > 0, "a play command");
    assert.equal((tv.commands[0] as { action: string; item: { videoId: string } }).action, "play");
    assert.equal((tv.commands[0] as { item: { videoId: string } }).item.videoId, song.videoId);
  });
});
