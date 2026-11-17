import assert from "node:assert/strict";
import { test } from "node:test";
import { LuxError } from "../src/util.js";
import { openSource, origKey, parseRange, prepareFile } from "../src/mirror.js";

// Workers-only global: a pass-through stream with a declared length.
globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };

/** In-memory stand-in for the R2 binding (head / get with range / put). */
function fakeR2() {
  const store = new Map();
  return {
    store,
    async head(key) {
      const o = store.get(key);
      return o ? { size: o.bytes.length, httpMetadata: o.meta } : null;
    },
    async get(key, opts) {
      const o = store.get(key);
      if (!o) return null;
      const r = opts?.range;
      const bytes = r ? o.bytes.slice(r.offset, r.offset + r.length) : o.bytes;
      return { body: new Response(bytes).body };
    },
    async put(key, value, opts) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      store.set(key, { bytes, meta: opts?.httpMetadata });
    },
  };
}

const ORIGINAL = new TextEncoder().encode("0123456789");

function fakeProvider({ thumbFails = false } = {}) {
  const calls = { download: 0, thumb: 0, full: 0 };
  return {
    calls,
    async openDownload(env, ref, range) {
      calls.download++;
      return new Response(ORIGINAL, { headers: { "content-length": String(ORIGINAL.length) } });
    },
    async getThumb() {
      calls.thumb++;
      if (thumbFails) throw new LuxError(503, "LS-DRV-RATE", "test");
      return { bytes: new Uint8Array([1]), contentType: "image/jpeg" };
    },
    async getFull() {
      calls.full++;
      return { bytes: new Uint8Array([2]), contentType: "image/jpeg" };
    },
  };
}

test("parseRange", () => {
  assert.deepEqual(parseRange("bytes=2-", 10), { start: 2, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=0-99", 10), { start: 0, end: 9 });
  assert.equal(parseRange("bytes=10-", 10), null);
  assert.equal(parseRange("", 10), null);
});

test("prepareFile copies every part of a photo, then reports them cached", async () => {
  const env = { CACHE: fakeR2() };
  const p = fakeProvider();
  const file = { ref: "abc1234567", name: "a.jpg", video: false };
  assert.deepEqual(await prepareFile(env, p, "drive", file), { thumb: "copied", full: "copied", orig: "copied" });
  assert.deepEqual(env.CACHE.store.get(origKey("drive", "abc1234567")).bytes, ORIGINAL);
  assert.equal(env.CACHE.store.get(origKey("drive", "abc1234567")).meta.contentType, "image/jpeg");

  assert.deepEqual(await prepareFile(env, p, "drive", file), { thumb: "cached", full: "cached", orig: "cached" });
  assert.deepEqual(p.calls, { download: 1, thumb: 1, full: 1 }, "a second run must not touch the source");
});

test("prepareFile skips the full preview for videos and reports failures without throwing", async () => {
  const env = { CACHE: fakeR2() };
  const result = await prepareFile(env, fakeProvider({ thumbFails: true }), "drive", { ref: "vid1234567", name: "c.MP4", video: true });
  assert.equal(result.thumb.code, "LS-DRV-RATE");
  assert.equal(result.orig, "copied");
  assert.equal("full" in result, false);
});

test("openSource serves the R2 copy (with ranges) and falls back to the source", async () => {
  const env = { CACHE: fakeR2() };
  const p = fakeProvider();

  const miss = await openSource(env, p, "drive", "abc1234567");
  assert.equal(miss.headers.get("x-luxsync-source"), "source");
  await miss.body.cancel();

  await prepareFile(env, p, "drive", { ref: "abc1234567", name: "a.MP4", video: true });
  const whole = await openSource(env, p, "drive", "abc1234567");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("x-luxsync-source"), "r2");
  assert.equal(await whole.text(), "0123456789");

  const part = await openSource(env, p, "drive", "abc1234567", "bytes=4-");
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 4-9/10");
  assert.equal(part.headers.get("content-length"), "6");
  assert.equal(await part.text(), "456789");
  assert.equal(p.calls.download, 2, "only the miss and the copy hit the source");
});
