import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pairCast } from "../src/playback/lounge.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const reply = (body: string, status = 200) => {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
};

describe("pairing with an unexpected YouTube reply", () => {
  const code = "123456789012";

  it("accepts a well-formed reply", async () => {
    reply(JSON.stringify({ screen: { screenId: "s1", loungeToken: "tok", name: "Living room" } }));
    assert.deepEqual(await pairCast(code), { screenId: "s1", loungeToken: "tok", name: "Living room" });
  });

  for (const [what, body] of [
    ["not JSON", "<html>oops</html>"],
    ["a JSON array", "[1,2]"],
    ["null", "null"],
    ["screen as a number", '{"screen":5}'],
    ["fields of the wrong type", '{"screen":{"screenId":7,"loungeToken":{}}}'],
    ["empty fields", '{"screen":{"screenId":"","loungeToken":""}}'],
  ] as const) {
    it(`fails cleanly on ${what}`, async () => {
      reply(body);
      await assert.rejects(pairCast(code), /returned no TV/);
    });
  }

  it("reports an upstream error status", async () => {
    reply("", 500);
    await assert.rejects(pairCast(code), /pairing failed \(500\)/);
  });
});
