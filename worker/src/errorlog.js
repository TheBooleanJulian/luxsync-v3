// Error console for /admin. Server errors are queued in memory by util.js
// (recordError, from every LuxError and describe()) and written here to D1
// table error_log by flushErrors(). Visitors' browsers also send the error
// report they're shown (POST /api/client-error), so the photographer sees what
// the client would otherwise screenshot. Rows older than ERROR_LOG_DAYS
// (default 30) are pruned by the cron run.
import { HttpError, clientIp, errorQueue, hashIp, recordError } from "./util.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS error_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, origin TEXT NOT NULL,
     code TEXT NOT NULL, ref TEXT, status INTEGER, path TEXT, gallery TEXT,
     context TEXT, report TEXT, ip_hash TEXT)`,
  "CREATE INDEX IF NOT EXISTS error_log_ts ON error_log (ts)",
  "CREATE INDEX IF NOT EXISTS error_log_ref ON error_log (ref)",
];
// Per-DB flag, not a shared promise: awaiting another request's pending I/O can hang.
const schemaDone = new WeakSet();
async function ensureSchema(env) {
  if (schemaDone.has(env.DB)) return;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  schemaDone.add(env.DB);
}

const clip = (v, n) => (v === null || v === undefined || v === "" ? null : String(v).slice(0, n));
const HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

/** Write every queued error to D1. Never throws: logging must not break a response. */
export async function flushErrors(env) {
  if (!errorQueue.length || !env?.DB) return;
  const entries = errorQueue.splice(0);
  try {
    await ensureSchema(env);
    const stmts = entries.map((e) =>
      env.DB.prepare(
        "INSERT INTO error_log (ts, origin, code, ref, status, path, gallery, context, report, ip_hash)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        e.ts, e.origin, clip(e.code, 80) || "LS-UNKNOWN", clip(e.ref, 60), Number.isFinite(e.status) ? e.status : null,
        clip(e.path, 200), clip(e.gallery, 200), clip(e.context, 1000), clip(e.report, 4000), clip(e.ip_hash, 32),
      ),
    );
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  } catch (err) {
    console.error(`error log flush failed (${entries.length} entries dropped)`, err);
  }
}

const CODE_RE = /^LS-[A-Z0-9-]{2,30}$/;
const REF_RE = /^[0-9A-F]{6}$/;
const SOURCE_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** POST /api/client-error: the error report a visitor's browser just showed.
 * Public, so everything is validated and capped; it's only ever read in /admin
 * (rendered as text). */
export async function recordClientReport(env, request, body) {
  const report = String(body?.report ?? "").slice(0, 4000);
  if (!report.startsWith("LUXSYNC ERROR REPORT")) throw new HttpError(400, "Invalid report");
  const list = (v, re, max) => (Array.isArray(v) ? v.map(String).filter((x) => re.test(x)).slice(0, max) : []);
  const codes = list(body.codes, CODE_RE, 10);
  const refs = list(body.refs, REF_RE, 6);
  const source = SOURCE_RE.test(String(body.source ?? "")) ? String(body.source) : null;
  recordError({
    origin: "client", code: codes.join(", ") || "LS-UNKNOWN", ref: refs.join(",") || null, status: null,
    path: "browser", gallery: source, context: clip(body.gallery_name, 200), report,
    ip_hash: await hashIp(env, clientIp(request)),
  });
  await flushErrors(env);
}

/** Newest first. q matches ref, code, gallery, context or report text. */
export async function listErrors(env, { q = "", origin = "", code = "", limit = 100, offset = 0 } = {}) {
  await ensureSchema(env);
  const where = [], args = [];
  if (origin === "server" || origin === "client") { where.push("origin = ?"); args.push(origin); }
  if (code) { where.push("code LIKE ?"); args.push(`%${code}%`); }
  if (q) {
    where.push("(ref LIKE ? OR code LIKE ? OR gallery LIKE ? OR context LIKE ? OR report LIKE ? OR path LIKE ?)");
    for (let i = 0; i < 6; i++) args.push(`%${q}%`);
  }
  const cond = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const { results: items } = await env.DB.prepare(`SELECT * FROM error_log${cond} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...args, limit, offset).all();
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM error_log${cond}`).bind(...args).first();
  return { items, total: row?.n ?? 0 };
}

/** Totals, per-code counts and an hourly series for the Health tab. */
export async function errorSummary(env, now = Date.now()) {
  await ensureSchema(env);
  const day = iso(now - 24 * HOUR);
  const count = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).first())?.n ?? 0;
  const [server24, client24, week, capped1h] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM error_log WHERE origin = 'server' AND ts >= ?", day),
    count("SELECT COUNT(*) AS n FROM error_log WHERE origin = 'client' AND ts >= ?", day),
    count("SELECT COUNT(*) AS n FROM error_log WHERE ts >= ?", iso(now - 7 * 24 * HOUR)),
    count("SELECT COUNT(*) AS n FROM error_log WHERE code = 'LS-DRV-FILE' AND ts >= ?", iso(now - HOUR)),
  ]);
  const { results: byCode } = await env.DB.prepare(
    "SELECT code, origin, COUNT(*) AS n, MAX(ts) AS last FROM error_log WHERE ts >= ?" +
      " GROUP BY code, origin ORDER BY n DESC LIMIT 30",
  ).bind(day).all();
  const { results: hours } = await env.DB.prepare(
    "SELECT substr(ts, 1, 13) AS h, origin, COUNT(*) AS n FROM error_log WHERE ts >= ? GROUP BY h, origin",
  ).bind(iso(now - 23 * HOUR - (now % HOUR))).all();
  // 24 hourly buckets ending with the current hour, zero-filled.
  const hourly = [];
  for (let i = 23; i >= 0; i--) {
    const h = iso(now - i * HOUR).slice(0, 13);
    const server = hours.find((r) => r.h === h && r.origin === "server")?.n ?? 0;
    const client = hours.find((r) => r.h === h && r.origin === "client")?.n ?? 0;
    hourly.push({ hour: `${h}:00:00.000Z`, server, client });
  }
  return { server24, client24, week, capped1h, byCode, hourly };
}

export async function pruneErrors(env, { days = Number(env.ERROR_LOG_DAYS) || 30, now = Date.now() } = {}) {
  await ensureSchema(env);
  await env.DB.prepare("DELETE FROM error_log WHERE ts < ?").bind(iso(now - days * 24 * HOUR)).run();
}
