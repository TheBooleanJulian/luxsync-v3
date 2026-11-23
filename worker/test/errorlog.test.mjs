import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { errorSummary, flushErrors, listErrors, pruneErrors, recordClientReport } from "../src/errorlog.js";
import { HttpError, LuxError, describe, errorQueue, recordError } from "../src/util.js";

/** Just enough of the D1 binding over node:sqlite. */
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
const fresh = () => { errorQueue.length = 0; return { DB: fakeD1() }; };
const request = (ip = "1.2.3.4") => ({ headers: new Map([["CF-Connecting-IP", ip]]) });

test("a LuxError is queued and written to D1, with where it happened", async () => {
  const env = fresh();
  const err = new LuxError(503, "LS-DRV-FILE", "file=abc");
  describe(err, "zip member a.jpg");
  assert.equal(errorQueue.length, 1, "describe() of a LuxError doesn't log it twice");
  await flushErrors(env);
  assert.equal(errorQueue.length, 0);
  const { items, total } = await listErrors(env);
  assert.equal(total, 1);
  assert.equal(items[0].code, "LS-DRV-FILE");
  assert.equal(items[0].ref, err.detail.ref);
  assert.equal(items[0].status, 503);
  assert.equal(items[0].origin, "server");
  assert.equal(items[0].context, "zip member a.jpg · file=abc");
});

test("describe() logs other errors under the given fallback code", async () => {
  const env = fresh();
  const d = describe(new Error("socket hang up"), "prepare orig x.mov", "LS-PREP-FAIL");
  describe(new HttpError(500, "boom"), "zip");
  await flushErrors(env);
  const { items } = await listErrors(env);
  assert.deepEqual(items.map((r) => r.code), ["LS-HTTP-500", "LS-PREP-FAIL"]);
  assert.equal(items[1].ref, d.ref);
  assert.match(items[1].context, /prepare orig x\.mov: socket hang up/);
});

test("client reports are validated and stored; junk is filtered", async () => {
  const env = fresh();
  await recordClientReport(env, request(), {
    report: "LUXSYNC ERROR REPORT\nCodes: LS-DRV-FILE\nRef: 014418",
    codes: ["LS-DRV-FILE", "<script>"], refs: ["014418", "nope"], source: "1GTHvoPpusBPFu35nwS4zPYn0NVBMJr1N",
    gallery_name: "2026_11_21 Fatui National Gallery",
  });
  const { items } = await listErrors(env, { origin: "client" });
  assert.equal(items.length, 1);
  assert.equal(items[0].code, "LS-DRV-FILE");
  assert.equal(items[0].ref, "014418");
  assert.equal(items[0].gallery, "1GTHvoPpusBPFu35nwS4zPYn0NVBMJr1N");
  assert.match(items[0].ip_hash, /^[0-9a-f]{16}$/);

  await assert.rejects(recordClientReport(env, request(), { report: "hello" }), { status: 400 });
  await recordClientReport(env, request(), { report: "LUXSYNC ERROR REPORT", source: "../../etc" });
  assert.equal((await listErrors(env, { origin: "client" })).items[0].gallery, null, "bad source id dropped");
});

test("search finds a client's ref on both the server row and the client report", async () => {
  const env = fresh();
  const err = new LuxError(503, "LS-DRV-FILE", "file=abc");
  new LuxError(404, "LS-DRV-GONE", "file=zzz");
  await flushErrors(env);
  await recordClientReport(env, request(), { report: "LUXSYNC ERROR REPORT", codes: ["LS-DRV-FILE"], refs: [err.detail.ref] });
  const { items, total } = await listErrors(env, { q: err.detail.ref });
  assert.equal(total, 2);
  assert.deepEqual(items.map((r) => r.origin).sort(), ["client", "server"]);
  assert.equal((await listErrors(env, { code: "GONE" })).total, 1);
});

test("an error storm is capped per minute and summarised, client reports aren't", async () => {
  const env = fresh();
  const t0 = Date.parse("2030-01-01T00:00:00Z");   // far from the other tests' windows
  for (let i = 0; i < 100; i++) recordError({ code: "LS-DRV-RATE" }, t0 + i);
  recordError({ origin: "client", code: "LS-DRV-RATE" }, t0 + 200);
  assert.equal(errorQueue.length, 61, "60 server rows + the client report");
  recordError({ code: "LS-DRV-GONE" }, t0 + 61_000);   // next minute: summary row, then this one
  const sampled = errorQueue.find((e) => e.code === "LS-LOG-SAMPLED");
  assert.match(sampled.context, /^40 more server errors/);
  assert.equal(errorQueue.at(-1).code, "LS-DRV-GONE");
  await flushErrors(env);
  assert.equal((await listErrors(env)).total, 63);
});

test("summary counts the last 24 h in hourly buckets; pruning drops old rows", async () => {
  const env = fresh();
  const now = Date.parse("2026-11-24T10:30:00Z");
  const put = (ts, origin, code) => env.DB.raw.prepare(
    "INSERT INTO error_log (ts, origin, code) VALUES (?,?,?)").run(ts, origin, code);
  await flushErrors(env); // nothing queued: no table yet
  await listErrors(env);  // creates the table
  put("2026-11-24T10:05:00.000Z", "server", "LS-DRV-FILE");
  put("2026-11-24T10:10:00.000Z", "server", "LS-DRV-FILE");
  put("2026-11-24T09:59:00.000Z", "client", "LS-JOB-LOST");
  put("2026-11-22T10:00:00.000Z", "server", "LS-DRV-RATE");
  put("2026-10-01T00:00:00.000Z", "server", "LS-DRV-RATE");
  const s = await errorSummary(env, now);
  assert.equal(s.server24, 2);
  assert.equal(s.client24, 1);
  assert.equal(s.capped1h, 2);
  assert.equal(s.week, 4);
  assert.equal(s.hourly.length, 24);
  assert.deepEqual(s.hourly.at(-1), { hour: "2026-11-24T10:00:00.000Z", server: 2, client: 0 });
  assert.deepEqual(s.hourly.at(-2), { hour: "2026-11-24T09:00:00.000Z", server: 0, client: 1 });
  assert.equal(s.byCode[0].code, "LS-DRV-FILE");

  await pruneErrors(env, { days: 30, now });
  assert.equal((await listErrors(env)).total, 4, "the October row is gone");
});
