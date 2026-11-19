import assert from "node:assert/strict";
import { test } from "node:test";
import { getThumb } from "../src/providers/drive.js";

test("Drive images come from the lh3 CDN, falling back to drive.google.com/thumbnail", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(new URL(url).host);
    if (new URL(url).host === "lh3.googleusercontent.com") return new Response("<html>", { status: 500, headers: { "content-type": "text/html" } });
    return new Response(new Uint8Array([0xff, 0xd8]), { headers: { "content-type": "image/jpeg" } });
  });
  const { contentType } = await getThumb({}, "abc1234567");
  assert.equal(contentType, "image/jpeg");
  assert.deepEqual(seen, ["lh3.googleusercontent.com", "drive.google.com"]);
});

test("many concurrent thumbnail requests don't queue behind each other", async (t) => {
  // Regression: a shared 10-slot semaphore leaked slots from cancelled requests (error 1101).
  let inFlight = 0, peak = 0;
  t.mock.method(globalThis, "fetch", async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
  });
  await Promise.all(Array.from({ length: 30 }, (_, i) => getThumb({}, `ref000000${i}`)));
  assert.equal(peak, 30);
});
