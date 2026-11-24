import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, createRoom, startServer, wait, type TestServer } from "./harness.ts";

let server: TestServer;
before(async () => void (server = await startServer({ KARAOKE_BLOCK_TEMP_MS: "300" })));
after(async () => void (await server.stop()));

const open: Client[] = [];
const client = (id: string) => {
  const c = new Client(server.url, id);
  open.push(c);
  return c;
};
after(() => open.forEach((c) => c.socket.close()));

type Failure = { ok: false; error: string; needsScreenCode?: boolean };

/** A room a phone made, with its host already in. */
async function hostedRoom(tag: string) {
  const { code, hostToken } = await createRoom(server.url);
  const host = client(`host-${tag}`);
  await host.join(code, hostToken);
  return { code, hostToken, host };
}

/** The room's screen code, as the host sees it. */
const screenCodeOf = async (host: Client) => {
  const r = (await host.ask<{ screenCode: string }>("screen:code")) as { ok: true; screenCode: string };
  assert.equal(r.ok, true);
  return r.screenCode;
};

describe("the screen code", () => {
  it("lets the first screen into a brand-new room for free and hands it the code", async () => {
    const { code } = await createRoom(server.url, "screen");
    const tv = client("tv-new");
    const r = (await tv.joinScreen(code, "tv.local", {})) as { ok: true; screenCode: string };
    assert.equal(r.ok, true);
    assert.match(r.screenCode, /^[A-HJ-NP-Z2-9]{6}$/);
  });

  it("asks for the code once the room has a host, without counting that as a wrong guess", async () => {
    const { code } = await hostedRoom("asks");
    const tv = client("tv-asks");
    for (let i = 0; i < 8; i++) {
      const r = (await tv.joinScreen(code, "tv.local", {})) as Failure;
      assert.equal(r.ok, false);
      assert.equal(r.needsScreenCode, true);
      assert.match(r.error, /screen code/i);
    }
  });

  it("accepts the right code in any case and spacing, and refuses a wrong one", async () => {
    const { code, host } = await hostedRoom("right");
    const secret = await screenCodeOf(host);

    const wrong = (await client("tv-wrong").joinScreen(code, "tv.local", { screenCode: "AAAAAA" })) as Failure;
    assert.equal(wrong.ok, false);
    assert.equal(wrong.needsScreenCode, true);
    assert.match(wrong.error, /isn't right/);

    const typed = `${secret.slice(0, 3)} ${secret.slice(3)}`.toLowerCase();
    assert.equal((await client("tv-right").joinScreen(code, "tv.local", { screenCode: typed })).ok, true);
  });

  it("accepts the host's own token, which is how Play on this device works", async () => {
    const { code, hostToken } = await hostedRoom("token");
    assert.equal((await client("laptop").joinScreen(code, "laptop.local", { hostToken })).ok, true);
    const wrong = await client("laptop-2").joinScreen(code, "laptop.local", { hostToken: "0".repeat(32) });
    assert.equal(wrong.ok, false);
  });

  it("lets a screen back in with the code it was given, after a reconnect", async () => {
    const { code } = await createRoom(server.url, "screen");
    const tv = client("tv-reconnect");
    const first = (await tv.joinScreen(code, "tv.local", {})) as { ok: true; screenCode: string };
    const phone = client("phone-reconnect");
    await phone.join(code); // the first phone in becomes the host, so the room is now in use

    const stranger = (await client("tv-stranger").joinScreen(code, "tv.local", {})) as Failure;
    assert.equal(stranger.needsScreenCode, true, "a screen that was in the room before still needs the code");
    assert.equal((await client("tv-again").joinScreen(code, "tv.local", { screenCode: first.screenCode })).ok, true);
  });

  it("leaves the current screen alone when someone fails to take over", async () => {
    const { code, host } = await hostedRoom("intruder");
    const tv = client("tv-current");
    assert.equal((await tv.joinScreen(code)).ok, true);
    await host.waitState((s) => s.screens === 1);

    await client("tv-intruder").joinScreen(code, "evil.local", { screenCode: "ZZZZZZ" });
    await wait(150);
    assert.equal(tv.replacedBy, null);
    assert.equal(tv.socket.connected, true);
    assert.equal(host.state.screens, 1);
  });

  it("locks a device out after five wrong codes in a row", async () => {
    const { code, host } = await hostedRoom("lockout");
    const secret = await screenCodeOf(host);
    const guesser = client("tv-guesser");
    // (other tests in this file share the address and may have counted a guess or two already)
    let last = (await guesser.joinScreen(code, "x.local", { screenCode: "BBBBBB" })) as Failure;
    for (let i = 1; i < 5 && !/Try again in/.test(last.error); i++) last = (await guesser.joinScreen(code, "x.local", { screenCode: "BBBBBB" })) as Failure;
    assert.match(last.error, /Try again in/);
    assert.equal(last.needsScreenCode, false, "the prompt goes away while the device is locked out");

    const right = (await guesser.joinScreen(code, "x.local", { screenCode: secret })) as Failure;
    assert.equal(right.ok, false, "even the right code is refused during the timeout");
  });

  it("shows the code only to the host or the screen, and never in the room state", async () => {
    const { code, host } = await hostedRoom("private");
    const secret = await screenCodeOf(host);
    const guest = client("guest-private");
    await guest.join(code);
    assert.equal(((await guest.ask("screen:code")) as Failure).ok, false);
    assert.equal(JSON.stringify(host.state).includes(secret), false);
    assert.equal(JSON.stringify(guest.state).includes(secret), false);
  });
});
