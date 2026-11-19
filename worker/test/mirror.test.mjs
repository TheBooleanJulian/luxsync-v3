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

// ---------- background runner ----------
import { DatabaseSync } from "node:sqlite";
import { listMirrors, registerGallery, runMirror, setPaused } from "../src/mirror.js";

/** Just enough of the D1 binding (prepare/bind/run/all/first/batch) over node:sqlite. */
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() { db.prepare(sql).run(...args); return { success: true }; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
  });
  return { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) await s.run(); }, raw: db };
}

function galleryProvider(files, { failRefs = new Set() } = {}) {
  const p = fakeProvider();
  p.listGallery = async () => ({ name: "Shoot", files });
  const base = p.openDownload;
  p.openDownload = async (env, ref, range) => {
    if (failRefs.has(ref)) throw new LuxError(503, "LS-DRV-FILE", "blocked");
    return base(env, ref, range);
  };
  return p;
}

const due = (env) => env.DB.raw.prepare("UPDATE mirror_galleries SET next_check = '2000-01-01T00:00:00.000Z'").run();

test("runMirror mirrors an opened gallery, then leaves it alone", async () => {
  const env = { CACHE: fakeR2(), DB: fakeD1() };
  const files = [{ id: "photo123456", name: "a.jpg" }, { id: "video123456", name: "b.MP4" }];
  const p = galleryProvider(files);
  await registerGallery(env, "drive", "folder1234", "Shoot");
  await runMirror(env, { drive: p });

  const [g] = await listMirrors(env);
  assert.equal(g.files, 2);
  assert.equal(g.ready, 2);
  assert.equal(g.failed, 0);
  assert.ok(g.next_check > new Date(Date.now() + 23 * 3600e3).toISOString(), "complete -> re-check in a day");
  assert.equal(env.CACHE.store.has("drive/full/video123456"), false, "no full preview for videos");

  await due(env);
  const before = { ...p.calls };
  await runMirror(env, { drive: p });
  assert.deepEqual(p.calls, before, "done files are skipped without touching the source or R2 copies");
});

test("runMirror retries failures later and finishes once the source recovers", async () => {
  const env = { CACHE: fakeR2(), DB: fakeD1() };
  const files = [{ id: "okay123456", name: "a.jpg" }, { id: "blocked1234", name: "b.MP4" }];
  const failRefs = new Set(["blocked1234"]);
  const p = galleryProvider(files, { failRefs });
  await registerGallery(env, "drive", "folder1234", "Shoot");
  await runMirror(env, { drive: p });

  let [g] = await listMirrors(env);
  assert.equal(g.ready, 1);
  assert.equal(g.failed, 1);
  assert.equal(g.last_error, "LS-DRV-FILE");
  const in30 = Date.now() + 30 * 60e3;
  assert.ok(Math.abs(Date.parse(g.next_check) - in30) < 60e3, "failure -> retry in 30 min");

  failRefs.clear();
  await due(env);
  await runMirror(env, { drive: p });
  [g] = await listMirrors(env);
  assert.equal(g.ready, 2);
  assert.equal(g.failed, 0);
});

test("runMirror stops at its per-run file budget and continues next run", async () => {
  const env = { CACHE: fakeR2(), DB: fakeD1() };
  const files = Array.from({ length: 5 }, (_, i) => ({ id: `photo00000${i}`, name: `${i}.jpg` }));
  const p = galleryProvider(files);
  await registerGallery(env, "drive", "folder1234", "Shoot");
  await runMirror(env, { drive: p }, { maxFiles: 3 });
  let [g] = await listMirrors(env);
  assert.equal(g.ready, 3);
  assert.ok(g.next_check <= new Date().toISOString(), "unfinished -> due again immediately");
  await runMirror(env, { drive: p }, { maxFiles: 3 });
  [g] = await listMirrors(env);
  assert.equal(g.ready, 5);
});

test("paused galleries are skipped; opening a gallery pulls its next check forward", async () => {
  const env = { CACHE: fakeR2(), DB: fakeD1() };
  const p = galleryProvider([{ id: "photo123456", name: "a.jpg" }]);
  await registerGallery(env, "drive", "folder1234", "Shoot");
  await setPaused(env, "drive", "folder1234", true);
  await runMirror(env, { drive: p });
  assert.equal(p.calls.download, 0);

  await setPaused(env, "drive", "folder1234", false);
  await runMirror(env, { drive: p });
  env.DB.raw.prepare("UPDATE mirror_galleries SET next_check = '2999-01-01T00:00:00.000Z'").run();
  await registerGallery(env, "drive", "folder1234", "Shoot (renamed)");
  const [g] = await listMirrors(env);
  assert.equal(g.name, "Shoot (renamed)");
  assert.ok(g.next_check <= new Date().toISOString());
});
