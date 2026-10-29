// Download-activity log (who downloaded what) in D1, for the /admin dashboard.
import { hashIp } from "./util.js";

/** Record one download. Never throws — a logging failure must not block the visitor's download. */
export async function logDownload(env, { email, optin, provider, source, galleryName, kind, filenames, fileCount, ip }) {
  try {
    await env.DB.prepare(
      "INSERT INTO downloads (ts, email, optin, provider, source, gallery_name, kind, file_count, filenames, ip_hash)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
        email, optin ? 1 : 0, provider, source, String(galleryName || "").slice(0, 200), kind,
        fileCount ?? filenames.length, JSON.stringify(filenames.slice(0, 500)), await hashIp(env, ip),
      )
      .run();
  } catch (err) {
    console.error("Failed to log download", err);
  }
}

export async function stats(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS downloads, COUNT(DISTINCT email) AS emails, COUNT(DISTINCT source) AS galleries FROM downloads",
  ).first();
  const optins = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM (SELECT email FROM downloads GROUP BY email HAVING MAX(optin) = 1)",
  ).first();
  return { ...row, optins: optins.n };
}

/** view: 'gallery' (whole-gallery + selection zips) or 'photo' (single files). */
export async function listDownloads(env, view, q = "", limit = 100, offset = 0) {
  const kinds = view === "photo" ? ["photo"] : ["all", "selected"];
  let where = `kind IN (${kinds.map(() => "?").join(",")})`;
  const params = [...kinds];
  if (q) {
    where += " AND (email LIKE ? OR gallery_name LIKE ? OR filenames LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE ${where}`).bind(...params).first()).n;
  const { results } = await env.DB.prepare(`SELECT * FROM downloads WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset)
    .all();
  const items = results.map(({ ip_hash, ...r }) => ({ ...r, filenames: JSON.parse(r.filenames) }));
  return { total, items };
}

export async function listEmails(env, q = "") {
  const where = q ? "WHERE email LIKE ?" : "";
  const stmt = env.DB.prepare(
    "SELECT email, MAX(optin) AS optin, COUNT(*) AS downloads, COUNT(DISTINCT source) AS galleries," +
      " MIN(ts) AS first_seen, MAX(ts) AS last_seen" +
      ` FROM downloads ${where} GROUP BY email ORDER BY last_seen DESC`,
  );
  const { results } = await (q ? stmt.bind(`%${q}%`) : stmt).all();
  return results;
}
