import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { alertClientReport, checkAlerts, sendTelegram } from "../src/alerts.js";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() { db.prepare(sql).run(...args); return { success: true }; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
  });
  db.exec("CREATE TABLE error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, origin TEXT NOT NULL, code TEXT NOT NULL)");
  return { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) await s.run(); }, raw: db };
}
const env = () => ({ DB: fakeD1(), TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" });
function telegram() {
  const sent = [];
  const fetchFn = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); };
  return { sent, fetchFn };
}
const report = "LUXSYNC ERROR REPORT\nCodes: LS-DRV-FILE\nRef: 014418\nFailed: 1 of 1 file\nFiles: xymiku_850_6308.jpg";

test("no secrets set: alerts are off and nothing is sent", async () => {
  const { sent, fetchFn } = telegram();
  assert.equal(await sendTelegram({}, "hi", fetchFn), false);
  assert.equal(await alertClientReport({ DB: fakeD1() }, { codes: ["LS-DRV-FILE"], report }, { fetchFn }), false);
  assert.equal(sent.length, 0);
});

test("a client report sends one message per gallery per 30 minutes", async () => {
  const e = env();
  const { sent, fetchFn } = telegram();
  const info = { codes: ["LS-DRV-FILE"], gallery: "1GTHvoPpusBPFu35nwS4zPYn0NVBMJr1N", galleryName: "2026_11_21 Fatui National Gallery", report };
  const t0 = Date.parse("2026-11-27T10:00:00Z");
  assert.equal(await alertClientReport(e, info, { fetchFn, now: t0 }), true);
  assert.equal(await alertClientReport(e, info, { fetchFn, now: t0 + 60e3 }), false, "same gallery, a minute later");
  assert.equal(await alertClientReport(e, { ...info, gallery: "other0000001" }, { fetchFn, now: t0 + 60e3 }), true, "another gallery");
  assert.equal(await alertClientReport(e, info, { fetchFn, now: t0 + 31 * 60e3 }), true, "after 30 minutes");
  assert.equal(sent.length, 3);
  assert.equal(sent[0].url, "https://api.telegram.org/bot123:abc/sendMessage");
  assert.equal(sent[0].body.chat_id, "42");
  assert.match(sent[0].body.text, /Fatui National Gallery/);
  assert.match(sent[0].body.text, /xymiku_850_6308\.jpg/);
  assert.match(sent[0].body.text, /admin#errors/);
});

test("the cron alerts on a cap storm and on crashes, each throttled", async () => {
  const e = env();
  const { sent, fetchFn } = telegram();
  const now = Date.parse("2026-11-27T10:00:00Z");
  const put = (minsAgo, code) => e.DB.raw.prepare("INSERT INTO error_log (ts, origin, code) VALUES (?, 'server', ?)")
    .run(new Date(now - minsAgo * 60e3).toISOString(), code);
  for (let i = 0; i < 29; i++) put(10, "LS-DRV-FILE");
  await checkAlerts(e, { fetchFn, now });
  assert.equal(sent.length, 0, "29 cap errors: below the threshold of 30");
  put(5, "LS-DRV-FILE");
  put(3, "LS-UNHANDLED");
  await checkAlerts(e, { fetchFn, now });
  assert.equal(sent.length, 2);
  assert.match(sent[0].body.text, /capping downloads \(30 cap errors/);
  assert.match(sent[1].body.text, /LS-UNHANDLED/);
  await checkAlerts(e, { fetchFn, now: now + 5 * 60e3 });
  assert.equal(sent.length, 2, "both throttled on the next cron run");
});

test("a Telegram failure is reported as false, never thrown, and never logs the token", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...a) => logged.push(a.join(" ")));
  const fetchFn = async () => new Response("bad", { status: 401 });
  assert.equal(await sendTelegram(env(), "hi", fetchFn), false);
  assert.ok(logged.length);
  assert.ok(logged.every((l) => !l.includes("123:abc")));
});
