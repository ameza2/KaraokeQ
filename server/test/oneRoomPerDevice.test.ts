import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, createRoom, startServer, until, wait, type TestServer } from "./harness.ts";

// Every test client connects from the same address, so each one stands for a tab on one device.
describe("one room per device", () => {
  let server: TestServer;
  before(async () => void (server = await startServer({ KARAOKE_ONE_ROOM_PER_DEVICE: "1" })));
  after(async () => void (await server.stop()));

  const closedMessage = (c: Client) => {
    let message = "";
    c.socket.on("room:closed", (p) => (message = p.message));
    return () => message;
  };

  it("closes a device's first room when it joins another one, and says why", async () => {
    const [one, two] = [await createRoom(server.url), await createRoom(server.url)];
    const first = new Client(server.url, "first-tab");
    const said = closedMessage(first);
    assert.equal((await first.join(one.code)).ok, true);

    const second = new Client(server.url, "second-tab");
    assert.equal((await second.join(two.code)).ok, true);

    await until(() => said(), "the first room to be closed for this device");
    assert.match(said(), /another room on this device/);
    await until(() => !first.socket.connected, "the first socket to hang up");
    assert.equal(second.socket.connected, true, "the room the device just joined stays open");
    first.socket.close();
    second.socket.close();
  });

  it("lets one device have several tabs in the same room", async () => {
    const room = await createRoom(server.url);
    const a = new Client(server.url, "tab-a");
    const b = new Client(server.url, "tab-b");
    await a.join(room.code);
    await b.join(room.code);
    await wait(150);
    assert.equal(a.socket.connected && b.socket.connected, true);
    a.socket.close();
    b.socket.close();
  });

  it("closes a screen that was open in another room", async () => {
    const [one, two] = [await createRoom(server.url, "screen"), await createRoom(server.url)];
    const screen = new Client(server.url, "tv");
    const said = closedMessage(screen);
    await screen.joinScreen(one.code);

    const guest = new Client(server.url, "guest");
    await guest.join(two.code);
    await until(() => said(), "the screen to be closed");
    await until(() => !screen.socket.connected, "the screen socket to hang up");
    guest.socket.close();
  });

  it("is off when KARAOKE_ONE_ROOM_PER_DEVICE is 0", async () => {
    const loose = await startServer({ KARAOKE_ONE_ROOM_PER_DEVICE: "0" });
    try {
      const [one, two] = [await createRoom(loose.url), await createRoom(loose.url)];
      const a = new Client(loose.url, "a");
      const b = new Client(loose.url, "b");
      await a.join(one.code);
      await b.join(two.code);
      await wait(150);
      assert.equal(a.socket.connected && b.socket.connected, true);
      a.socket.close();
      b.socket.close();
    } finally {
      await loose.stop();
    }
  });
});
