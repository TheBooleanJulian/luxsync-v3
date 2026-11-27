// R2 mirror of gallery files. "Prepare gallery" in /admin copies every file's
// thumbnail, full-size preview and original bytes into R2 once, at a pace the
// source tolerates; visitors are then served from R2 and never wait on (or use
// up) Google Drive's burst throttling and per-file download limits. Files that
// were never prepared still fall back to the source, as before.
import { HttpError, LuxError, annotateError, describe, discardError, guessType, isVideo } from "./util.js";
import { flushErrors } from "./errorlog.js";

// Files bigger than one part are copied with an R2 multipart upload: one ranged
// download per part, each finished part recorded in D1 (mirror_uploads). A copy
// that outlives its cron run, or is cut off, resumes from the last finished part
// instead of restarting a multi-GB file from zero (a single 3.4 GB clip once
// stalled a whole gallery that way). env.MIRROR_PART_BYTES overrides it (tests).
export const PART_BYTES = 256 * 1024 ** 2;

export const origKey = (providerName, ref) => `${providerName}/orig/${ref}`;
export const imageKey = (providerName, kind, ref) => `${providerName}/${kind}/${ref}`;

/** {start, end} (inclusive) for a single "bytes=" range, or null if absent/unsatisfiable. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {                                  // suffix: last N bytes
    start = Math.max(size - Number(m[2]), 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? null : { start, end };
}

/** Open a file's original bytes as an upstream-shaped Response (200, or 206 for
 * a Range): from the R2 mirror when present, else from the provider.
 * X-LuxSync-Source says which ("r2" / "source"). */
export async function openSource(env, provider, providerName, ref, range = null) {
  const key = origKey(providerName, ref);
  const head = await env.CACHE.head(key).catch(() => null);
  if (head) {
    const r = range ? parseRange(range, head.size) : null;
    const obj = await env.CACHE.get(key, r ? { range: { offset: r.start, length: r.end - r.start + 1 } } : undefined).catch(() => null);
    if (obj) {
      const headers = new Headers({
        "content-type": head.httpMetadata?.contentType || "application/octet-stream",
        "content-length": String(r ? r.end - r.start + 1 : head.size),
        "x-luxsync-source": "r2",
      });
      if (r) headers.set("content-range", `bytes ${r.start}-${r.end}/${head.size}`);
      return new Response(obj.body, { status: r ? 206 : 200, headers });
    }
  }
  const res = await provider.openDownload(env, ref, range);
  const headers = new Headers(res.headers);
  headers.set("x-luxsync-source", "source");
  return new Response(res.body, { status: res.status, headers });
}

/** Pipe `body` (exactly `length` bytes) into `sink` without buffering it:
 * FixedLengthStream gives R2 the length up front, and a cut transfer fails the
 * write, so a short object or part is never stored. */
async function pipeInto(body, length, sink, onBytes, offset, total) {
  let src = body;
  if (onBytes) {
    let received = offset;
    src = body.pipeThrough(new TransformStream({
      transform(chunk, ctl) {
        received += chunk.byteLength;
        onBytes(received, total);
        ctl.enqueue(chunk);
      },
    }));
  }
  const fixed = new FixedLengthStream(length);
  const [, out] = await Promise.all([src.pipeTo(fixed.writable), sink(fixed.readable)]);
  return out;
}

async function getUpload(env, providerName, ref) {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT upload_id, size, parts FROM mirror_uploads WHERE provider = ? AND ref = ?")
    .bind(providerName, ref).first();
  return row ? { ...row, parts: JSON.parse(row.parts) } : null;
}

async function saveUpload(env, providerName, ref, u) {
  await env.DB.prepare(
    "INSERT INTO mirror_uploads (provider, ref, upload_id, size, parts, updated_at) VALUES (?,?,?,?,?,?)" +
      " ON CONFLICT(provider, ref) DO UPDATE SET upload_id = excluded.upload_id, size = excluded.size," +
      " parts = excluded.parts, updated_at = excluded.updated_at",
  ).bind(providerName, ref, u.upload_id, u.size, JSON.stringify(u.parts), iso()).run();
}

const dropUpload = (env, providerName, ref) =>
  env.DB.prepare("DELETE FROM mirror_uploads WHERE provider = ? AND ref = ?").bind(providerName, ref).run();

/** Copy a file's original bytes into R2. Returns "copied", or "partial" when
 * `stopAt` passed with parts still to go (progress is saved; call again). */
async function copyOriginal(env, provider, providerName, ref, name, { onBytes, stopAt } = {}) {
  const key = origKey(providerName, ref);
  const partBytes = Number(env.MIRROR_PART_BYTES) || PART_BYTES;
  let upload = await getUpload(env, providerName, ref);

  if (!upload) {
    const res = await provider.openDownload(env, ref);
    const size = Number(res.headers.get("content-length")) || 0;
    if (!size) {
      await res.body?.cancel();
      throw new LuxError(502, "LS-SRC-EMPTY", `file=${ref} (no length)`);
    }
    const contentType = guessType(name) || res.headers.get("content-type") || "application/octet-stream";
    if (size <= partBytes) {
      await pipeInto(res.body, size, (s) => env.CACHE.put(key, s, { httpMetadata: { contentType } }), onBytes, 0, size);
      return "copied";
    }
    await res.body.cancel();
    const mpu = await env.CACHE.createMultipartUpload(key, { httpMetadata: { contentType } });
    upload = { upload_id: mpu.uploadId, size, parts: [] };
    await saveUpload(env, providerName, ref, upload);
  }

  const mpu = env.CACHE.resumeMultipartUpload(key, upload.upload_id);
  const count = Math.ceil(upload.size / partBytes);
  let doneNow = 0;
  try {
    for (let n = upload.parts.length + 1; n <= count; n++) {
      // Always finish at least one part per call, so every run makes progress.
      if (stopAt && doneNow > 0 && Date.now() >= stopAt) return "partial";
      const start = (n - 1) * partBytes;
      const end = Math.min(upload.size, n * partBytes) - 1;
      const res = await provider.openDownload(env, ref, `bytes=${start}-${end}`);
      if (res.status !== 206) {
        await res.body?.cancel();
        throw new LuxError(502, "LS-PREP-RANGE", `file=${ref} part=${n} status=${res.status}`);
      }
      const part = await pipeInto(res.body, end - start + 1, (s) => mpu.uploadPart(n, s), onBytes, start, upload.size);
      upload.parts.push({ partNumber: part.partNumber, etag: part.etag });
      await saveUpload(env, providerName, ref, upload);
      doneNow++;
    }
    await mpu.complete(upload.parts);
  } catch (err) {
    // R2 aborts unfinished uploads after a while; a gone upload can't resume, so start over next time.
    if (/does not exist|NoSuchUpload|10024/i.test(String(err?.message))) await dropUpload(env, providerName, ref);
    throw err;
  }
  await dropUpload(env, providerName, ref);
  return "copied";
}

/** Mirror one file. Each part is checked first, so re-running Prepare only
 * fetches what's missing. Never throws: returns {part: "cached" | "copied" |
 * "partial" | {code, message, ref}} for thumb, full (photos only) and orig.
 * "partial" = a big original stopped at `stopAt` with its progress saved. */
export async function prepareFile(env, provider, providerName, { ref, name, video }, onBytes = null, { stopAt } = {}) {
  const parts = video ? ["thumb", "orig"] : ["thumb", "full", "orig"];
  const result = {};
  for (const part of parts) {
    const key = part === "orig" ? origKey(providerName, ref) : imageKey(providerName, part, ref);
    try {
      if (await env.CACHE.head(key)) {
        result[part] = "cached";
      } else if (part === "orig") {
        result[part] = await copyOriginal(env, provider, providerName, ref, name, { onBytes, stopAt });
      } else {
        const { bytes, contentType } = await (part === "thumb" ? provider.getThumb : provider.getFull)(env, ref);
        await env.CACHE.put(key, bytes, { httpMetadata: { contentType } });
        result[part] = "copied";
      }
    } catch (err) {
      // Google has no preview for some files (Insta360 .insv, .lrv proxies, a few
      // JPEGs). That isn't a failure: the original is what matters, and retrying
      // the preview every 30 minutes forever only fills the error log.
      if (part !== "orig" && err instanceof LuxError && err.detail.code === "LS-DRV-GONE") {
        discardError(err.detail.ref);
        result[part] = "none";
        continue;
      }
      const d = describe(err, `prepare ${part} ${name} (${ref})`, "LS-PREP-FAIL");
      result[part] = err instanceof HttpError ? d : { ...d, message: String(err?.message || err) };
    }
  }
  return result;
}

/** POST /api/admin/prepare {provider, source, id, name}. Streams NDJSON:
 * {"bytes":n,"total":n} progress lines (so a multi-GB copy keeps the connection
 * alive), then {"done":true,"parts":{...}}. A fully mirrored file is recorded
 * against its gallery (file.source) so the cron runner skips it. */
export function prepareResponse(env, ctx, provider, providerName, file) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj) => writer.write(enc.encode(JSON.stringify(obj) + "\n")).catch(() => {});
  let last = 0;
  const onBytes = (bytes, total) => {
    if (Date.now() - last < 1000) return;
    last = Date.now();
    send({ bytes, total });
  };
  const work = prepareFile(env, provider, providerName, file, onBytes)
    .then(async (parts) => {
      if (file.source && isReady(parts)) await markDone(env, providerName, file.source, file.ref).catch(() => {});
      return send({ done: true, parts });
    })
    .catch((err) => send({ done: true, error: err instanceof HttpError ? err.detail : String(err) }))
    .finally(() => writer.close().catch(() => {}))
    .then(() => flushErrors(env));
  ctx.waitUntil(work);
  return new Response(readable, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}

// ---------- automatic mirroring (Cron Trigger) ----------
// Every gallery a visitor opens is registered. A cron run every 5 minutes
// mirrors whatever is missing, picks up files uploaded later, and keeps
// retrying failures (e.g. once Google lifts a per-file download block), so a
// gallery converges to fully mirrored without anyone pressing Prepare.
// Originals of a gallery nobody has opened for 30 days (MIRROR_EXPIRE_DAYS) are
// deleted from R2; thumbnails and previews are kept forever, so the gallery
// still browses instantly, and opening it again re-copies the originals.
// Additive tables, created on first use (also in schema.sql).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mirror_galleries (
     provider TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
     added_at TEXT NOT NULL, next_check TEXT NOT NULL, last_run TEXT,
     files INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
     last_error TEXT, paused INTEGER NOT NULL DEFAULT 0, last_opened TEXT, expired_at TEXT,
     PRIMARY KEY (provider, source))`,
  `CREATE TABLE IF NOT EXISTS mirror_files (
     provider TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL, done_at TEXT NOT NULL,
     PRIMARY KEY (provider, source, ref))`,
  `CREATE TABLE IF NOT EXISTS mirror_uploads (
     provider TEXT NOT NULL, ref TEXT NOT NULL, upload_id TEXT NOT NULL, size INTEGER NOT NULL,
     parts TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (provider, ref))`,
  // Watched folders (e.g. the year's deliverables folder): new gallery folders
  // created inside one are enrolled automatically (runWatch).
  `CREATE TABLE IF NOT EXISTS mirror_watch (
     provider TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
     added_at TEXT NOT NULL, last_scan TEXT, last_error TEXT, enrolled INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (provider, source))`,
];
// Columns added after the table first shipped. ADD COLUMN fails once the
// column exists (or the CREATE above already had it); that's expected.
const ADDED_COLUMNS = [
  "ALTER TABLE mirror_galleries ADD COLUMN last_opened TEXT",
  "ALTER TABLE mirror_galleries ADD COLUMN expired_at TEXT",
];
// Per-DB flag, not a shared promise: awaiting another request's pending I/O can hang.
const schemaDone = new WeakSet();
export async function ensureSchema(env) {
  if (schemaDone.has(env.DB)) return;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  for (const sql of ADDED_COLUMNS) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      if (!/duplicate column/i.test(String(err?.message))) throw err;
    }
  }
  schemaDone.add(env.DB);
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NEVER = "9999-12-31T00:00:00.000Z";   // next_check of an expired gallery: wait to be opened
// "none": Google has no preview of this file (see prepareFile).
const OK_PARTS = ["cached", "copied", "none"];
export const isReady = (parts) => Object.values(parts).every((v) => OK_PARTS.includes(v));

/** Called when a gallery is opened: register it, restart its 30-day clock,
 * and have the next cron run re-check it (new uploads, or re-copying expired
 * originals). Never throws — must not break the gallery. */
export async function registerGallery(env, providerName, source, name) {
  try {
    await ensureSchema(env);
    const now = iso();
    await env.DB.prepare(
      "INSERT INTO mirror_galleries (provider, source, name, added_at, next_check, last_opened) VALUES (?,?,?,?,?,?)" +
        " ON CONFLICT(provider, source) DO UPDATE SET name = excluded.name, last_opened = excluded.last_opened," +
        " expired_at = NULL, next_check = MIN(mirror_galleries.next_check, excluded.next_check)",
    ).bind(providerName, source, String(name || "").slice(0, 200), now, now, now).run();
  } catch (err) {
    console.error("registerGallery failed", err);
  }
}

export async function markDone(env, providerName, source, ref) {
  await ensureSchema(env);
  await env.DB.prepare("INSERT OR IGNORE INTO mirror_files (provider, source, ref, done_at) VALUES (?,?,?,?)")
    .bind(providerName, source, ref, iso()).run();
}

const GALLERY_FIELDS = new Set(["next_check", "last_run", "files", "ready", "failed", "last_error", "paused", "expired_at"]);
async function setGallery(env, g, fields) {
  const keys = Object.keys(fields).filter((k) => GALLERY_FIELDS.has(k));
  await env.DB.prepare(`UPDATE mirror_galleries SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE provider = ? AND source = ?`)
    .bind(...keys.map((k) => fields[k]), g.provider, g.source).run();
}

export async function listMirrors(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT * FROM mirror_galleries ORDER BY added_at DESC").all();
  return results;
}

export async function setPaused(env, providerName, source, paused) {
  await ensureSchema(env);
  // Resuming an expired gallery doesn't re-copy it; opening it does.
  await env.DB.prepare(
    "UPDATE mirror_galleries SET paused = ?, next_check = CASE WHEN expired_at IS NULL THEN ? ELSE next_check END" +
      " WHERE provider = ? AND source = ?",
  ).bind(paused ? 1 : 0, iso(), providerName, source).run();
}

/** Delete the R2 originals of galleries nobody has opened for `days` days
 * (thumbnails and previews stay). Their done-records go in the same step, for
 * every gallery holding those files, so nothing still counts a deleted file as
 * mirrored and a re-open copies it again. A file that's also in a gallery
 * opened within the window (a folder inside another) is kept. */
export async function expireOriginals(env, { days = Number(env.MIRROR_EXPIRE_DAYS) || 30, now = Date.now() } = {}) {
  await ensureSchema(env);
  const cutoff = iso(now - days * DAY);
  const { results: stale } = await env.DB.prepare(
    "SELECT provider, source FROM mirror_galleries WHERE expired_at IS NULL AND COALESCE(last_opened, added_at) < ? LIMIT 10",
  ).bind(cutoff).all();
  for (const g of stale) {
    const { results } = await env.DB.prepare(
      "SELECT f.ref, EXISTS (SELECT 1 FROM mirror_files o JOIN mirror_galleries og" +
        " ON og.provider = o.provider AND og.source = o.source" +
        " WHERE o.provider = f.provider AND o.ref = f.ref AND o.source != f.source" +
        " AND COALESCE(og.last_opened, og.added_at) >= ?) AS shared" +
        " FROM mirror_files f WHERE f.provider = ? AND f.source = ?",
    ).bind(cutoff, g.provider, g.source).all();
    const gone = results.filter((r) => !r.shared).map((r) => r.ref);
    for (let i = 0; i < gone.length; i += 1000) {
      await env.CACHE.delete(gone.slice(i, i + 1000).map((ref) => origKey(g.provider, ref)));
    }
    const forget = gone.map((ref) => env.DB.prepare("DELETE FROM mirror_files WHERE provider = ? AND ref = ?").bind(g.provider, ref));
    forget.push(env.DB.prepare("DELETE FROM mirror_files WHERE provider = ? AND source = ?").bind(g.provider, g.source));
    for (let i = 0; i < forget.length; i += 100) await env.DB.batch(forget.slice(i, i + 100));
    await setGallery(env, g, { expired_at: iso(now), ready: 0, failed: 0, last_error: null, next_check: NEVER });
    console.log(`expired originals of ${g.provider}/${g.source}: ${gone.length} deleted, ${results.length - gone.length} shared`);
  }
}

/** One cron run. Galleries are leased (next_check pushed out) while being
 * worked on, so an overlapping run skips them. maxFiles keeps one run well
 * under the per-invocation subrequest limit (~10-20 per file worst case). */
// Google's per-file cap (LS-DRV-FILE) lasts hours and can hit most of an
// account at once. After this many in a row, leave the gallery for CAP_WAIT
// and move on, rather than spending the run (and more requests) on it.
const CAP_STREAK = 3;
const CAP_WAIT = 3 * 60 * MINUTE;

export async function runMirror(env, providers, { budgetMs = 4 * MINUTE, maxFiles = 50, random = Math.random } = {}) {
  await ensureSchema(env);
  const stopAt = Date.now() + budgetMs;
  let left = maxFiles;
  // Never-copied galleries first, so a backlog of failing ones can't starve a new one.
  const { results: due } = await env.DB.prepare(
    "SELECT provider, source FROM mirror_galleries WHERE paused = 0 AND expired_at IS NULL AND next_check <= ?" +
      " ORDER BY last_run IS NOT NULL, next_check LIMIT 20",
  ).bind(iso()).all();

  for (const g of due) {
    if (Date.now() >= stopAt || left <= 0) break;
    const provider = providers[g.provider];
    if (!provider) continue;
    await setGallery(env, g, { next_check: iso(Date.now() + 15 * MINUTE) });

    let files;
    try {
      ({ files } = await provider.listGallery(env, g.source));
    } catch (err) {
      const d = describe(err, `mirror list ${g.provider}/${g.source}`);
      annotateError(d.ref, { gallery: g.source, path: "cron mirror" });
      await setGallery(env, g, { last_run: iso(), last_error: d.code, next_check: iso(Date.now() + 60 * MINUTE) });
      continue;
    }
    const { results } = await env.DB.prepare("SELECT ref FROM mirror_files WHERE provider = ? AND source = ?")
      .bind(g.provider, g.source).all();
    const done = new Set(results.map((r) => r.ref));
    let ready = files.filter((f) => done.has(f.id)).length;
    let failed = 0, complete = true, lastError = null, capped = 0;
    // Start at a random point so files that keep failing at the top of the
    // list don't block the ones after them run after run.
    const todo = files.filter((f) => !done.has(f.id));
    const start = Math.floor(random() * todo.length);

    for (const f of [...todo.slice(start), ...todo.slice(0, start)]) {
      if (Date.now() >= stopAt || left <= 0) { complete = false; break; }
      left--;
      const name = f.name || f.id;
      const parts = await prepareFile(env, provider, g.provider, { ref: f.id, name, video: isVideo(name) }, null, { stopAt });
      if (Object.values(parts).includes("partial")) { complete = false; break; }
      if (isReady(parts)) {
        await markDone(env, g.provider, g.source, f.id);
        ready++;
        capped = 0;
      } else {
        failed++;
        const bad = Object.values(parts).filter((v) => !OK_PARTS.includes(v));
        lastError = bad[0]?.code || "LS-PREP-FAIL";
        for (const b of bad) annotateError(b?.ref, { gallery: g.source, path: "cron mirror" });
        capped = lastError === "LS-DRV-FILE" ? capped + 1 : 0;
        if (capped >= CAP_STREAK) { complete = false; break; }
      }
    }
    // Capped by Google: wait hours. Unfinished: continue next run. Failures:
    // retry in 30 min. Done: re-check daily (and right away whenever someone
    // opens the gallery).
    const next = capped >= CAP_STREAK ? Date.now() + CAP_WAIT
      : !complete ? Date.now()
      : failed ? Date.now() + 30 * MINUTE
      : Date.now() + 24 * 60 * MINUTE;
    await setGallery(env, g, { last_run: iso(), files: files.length, ready, failed, last_error: lastError, next_check: iso(next) });
  }
}

// ---------- watched folders: mirror at delivery ----------
// Without this, a gallery is copied only once someone opens it, so the first
// client is always served from Drive (and can hit Google's cap). A watched
// folder is scanned every WATCH_EVERY, and each gallery folder created in it
// is enrolled as if it had been opened, so it's in R2 before the link goes out.
// Only folders created after the watch was added (less WATCH_GRACE) count:
// enrolling a whole year of old galleries at once would set off Google's cap.
const WATCH_EVERY = 15 * MINUTE;
const WATCH_GRACE = DAY;

export async function listWatches(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT * FROM mirror_watch ORDER BY added_at").all();
  return results;
}

export async function addWatch(env, providerName, source, name, now = Date.now()) {
  await ensureSchema(env);
  await env.DB.prepare(
    "INSERT INTO mirror_watch (provider, source, name, added_at) VALUES (?,?,?,?)" +
      " ON CONFLICT(provider, source) DO UPDATE SET name = excluded.name, last_scan = NULL",
  ).bind(providerName, source, String(name || "").slice(0, 200), iso(now)).run();
}

export async function removeWatch(env, providerName, source) {
  await ensureSchema(env);
  await env.DB.prepare("DELETE FROM mirror_watch WHERE provider = ? AND source = ?").bind(providerName, source).run();
}

/** Register a gallery found by a watch. Unlike registerGallery it never touches
 * an existing row, so scanning doesn't keep restarting a gallery's 30-day clock. */
async function enrolGallery(env, providerName, source, name, now) {
  const known = await env.DB.prepare("SELECT 1 AS x FROM mirror_galleries WHERE provider = ? AND source = ?")
    .bind(providerName, source).first();
  if (known) return 0;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO mirror_galleries (provider, source, name, added_at, next_check, last_opened) VALUES (?,?,?,?,?,?)",
  ).bind(providerName, source, String(name || "").slice(0, 200), iso(now), iso(now), iso(now)).run();
  return 1;
}

export async function runWatch(env, providers, now = Date.now()) {
  await ensureSchema(env);
  const { results: due } = await env.DB.prepare(
    "SELECT * FROM mirror_watch WHERE last_scan IS NULL OR last_scan <= ?",
  ).bind(iso(now - WATCH_EVERY)).all();
  for (const w of due) {
    const provider = providers[w.provider];
    if (!provider?.listSubfolders) continue;
    try {
      const since = Date.parse(w.added_at) - WATCH_GRACE;
      let added = 0;
      for (const f of await provider.listSubfolders(env, w.source)) {
        if (Date.parse(f.createdTime) >= since) added += await enrolGallery(env, w.provider, f.id, f.name, now);
      }
      await env.DB.prepare("UPDATE mirror_watch SET last_scan = ?, last_error = NULL, enrolled = enrolled + ? WHERE provider = ? AND source = ?")
        .bind(iso(now), added, w.provider, w.source).run();
    } catch (err) {
      const d = describe(err, `watch ${w.name || w.source}`);
      annotateError(d.ref, { gallery: w.source, path: "cron watch" });
      await env.DB.prepare("UPDATE mirror_watch SET last_scan = ?, last_error = ? WHERE provider = ? AND source = ?")
        .bind(iso(now), d.code, w.provider, w.source).run();
    }
  }
}
