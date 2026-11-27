// Telegram alerts to the photographer, so problems don't wait until someone
// opens /admin. Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set
// (Worker secrets). Outbound sendMessage only: no webhook, no polling, so it
// doesn't interfere with a bot that is also polling elsewhere.
//
// Each kind of alert has a key and a minimum gap (D1 alert_state), so a storm
// produces one message, not hundreds:
//   client:<gallery>   a visitor was shown an error report       30 min per gallery
//   cap                Google cap errors in the last hour >= ALERT_CAP_PER_HOUR (30)   6 h
//   crash:<code>       LS-UNHANDLED / LS-CRON-FAIL in the last 10 min                  1 h
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();

export const alertsConfigured = (env) => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
const adminUrl = (env, hash) => `${env.ADMIN_URL || "https://luxsync-v3.accurova.com/admin"}#${hash}`;

const schemaDone = new WeakSet();
async function ensureSchema(env) {
  if (schemaDone.has(env.DB)) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL)").run();
  schemaDone.add(env.DB);
}

/** POST the message to Telegram. Returns true if Telegram accepted it. The
 * token is part of the URL, so neither the URL nor the response is ever logged. */
export async function sendTelegram(env, text, fetchFn = fetch) {
  if (!alertsConfigured(env)) return false;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 3500), disable_web_page_preview: true }),
    });
    if (!res.ok) console.error(`Telegram alert failed: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error(`Telegram alert failed: ${err?.name || "error"}`);
    return false;
  }
}

/** Send unless an alert with this key went out less than gapMs ago. */
async function alertOnce(env, key, gapMs, text, { now = Date.now(), fetchFn = fetch } = {}) {
  if (!alertsConfigured(env)) return false;
  await ensureSchema(env);
  const last = await env.DB.prepare("SELECT sent_at FROM alert_state WHERE key = ?").bind(key).first();
  if (last && now - Date.parse(last.sent_at) < gapMs) return false;
  // Claim the slot before sending, so two isolates racing send one message.
  await env.DB.prepare("INSERT INTO alert_state (key, sent_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET sent_at = excluded.sent_at")
    .bind(key, iso(now)).run();
  return sendTelegram(env, text, fetchFn);
}

/** A visitor was just shown an error report (errorlog.recordClientReport). Never throws. */
export async function alertClientReport(env, { codes, gallery, galleryName, report }, opts) {
  try {
    const files = (String(report || "").split("\n").find((l) => l.startsWith("Files:")) || "").slice(7, 200);
    const failed = (String(report || "").split("\n").find((l) => l.startsWith("Failed:")) || "").slice(8, 60);
    const text = [
      `LuxSync: a client hit ${codes.join(", ") || "an error"}`,
      `Gallery: ${galleryName || gallery || "unknown"}`,
      failed ? `Failed: ${failed}` : "",
      files ? `Files: ${files}` : "",
      codes.includes("LS-DRV-FILE") ? "Google is capping downloads of these files. Push them to R2 or wait a few hours." : "",
      adminUrl(env, "errors"),
    ].filter(Boolean).join("\n");
    return await alertOnce(env, `client:${gallery || "unknown"}`, 30 * MINUTE, text, opts);
  } catch (err) {
    console.error("alertClientReport failed", err);
    return false;
  }
}

/** Run by the cron after the error log is flushed. Never throws. */
export async function checkAlerts(env, opts = {}) {
  if (!alertsConfigured(env)) return;
  const now = opts.now ?? Date.now();
  try {
    const count = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).first())?.n ?? 0;
    const threshold = Number(env.ALERT_CAP_PER_HOUR) || 30;
    const capped = await count("SELECT COUNT(*) AS n FROM error_log WHERE code = 'LS-DRV-FILE' AND ts >= ?", iso(now - HOUR));
    if (capped >= threshold) {
      await alertOnce(env, "cap", 6 * HOUR,
        `LuxSync: Google is capping downloads (${capped} cap errors in the last hour). ` +
        "The mirror backs off for 3 h per gallery; clients on galleries not yet in R2 may see LS-DRV-FILE.\n" +
        adminUrl(env, "health"), { ...opts, now });
    }
    for (const code of ["LS-UNHANDLED", "LS-CRON-FAIL"]) {
      const n = await count("SELECT COUNT(*) AS n FROM error_log WHERE code = ? AND ts >= ?", code, iso(now - 10 * MINUTE));
      if (n) {
        await alertOnce(env, `crash:${code}`, HOUR,
          `LuxSync: ${n} × ${code} in the last 10 minutes (${code === "LS-UNHANDLED" ? "the Worker crashed on a request" : "a background job crashed"}).\n` +
          adminUrl(env, "errors"), { ...opts, now });
      }
    }
  } catch (err) {
    console.error("checkAlerts failed", err);
  }
}
