// R2 mirror of gallery files. "Prepare gallery" in /admin copies every file's
// thumbnail, full-size preview and original bytes into R2 once, at a pace the
// source tolerates; visitors are then served from R2 and never wait on (or use
// up) Google Drive's burst throttling and per-file download limits. Files that
// were never prepared still fall back to the source, as before.
import { HttpError, LuxError, describe, guessType, isVideo } from "./util.js";

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
      const d = describe(err, `prepare ${part} ${name}`);
      // describe() labels non-HTTP errors as a zip failure; here it's a cut or failed copy.
      result[part] = err instanceof HttpError ? d : { ...d, code: "LS-PREP-FAIL", message: String(err?.message || err) };
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
    .finally(() => writer.close().catch(() => {}));
  ctx.waitUntil(work);
  return new Response(readable, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}

// ---------- automatic mirroring (Cron Trigger) ----------
// Every gallery a visitor opens is registered. A cron run every 5 minutes
// mirrors whatever is missing, picks up files uploaded later, and keeps
// retrying failures (e.g. once Google lifts a per-file download block), so a
// gallery converges to fully mirrored without anyone pressing Prepare.
// Additive tables, created on first use (also in schema.sql).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mirror_galleries (
     provider TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
     added_at TEXT NOT NULL, next_check TEXT NOT NULL, last_run TEXT,
     files INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
     last_error TEXT, paused INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (provider, source))`,
  `CREATE TABLE IF NOT EXISTS mirror_files (
     provider TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL, done_at TEXT NOT NULL,
     PRIMARY KEY (provider, source, ref))`,
  `CREATE TABLE IF NOT EXISTS mirror_uploads (
     provider TEXT NOT NULL, ref TEXT NOT NULL, upload_id TEXT NOT NULL, size INTEGER NOT NULL,
     parts TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (provider, ref))`,
];
// Per-DB flag, not a shared promise: awaiting another request's pending I/O can hang.
const schemaDone = new WeakSet();
export async function ensureSchema(env) {
  if (schemaDone.has(env.DB)) return;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  schemaDone.add(env.DB);
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const MINUTE = 60_000;
const OK_PARTS = ["cached", "copied"];
export const isReady = (parts) => Object.values(parts).every((v) => OK_PARTS.includes(v));

/** Called when a gallery is opened: register it, and have the next cron run
 * re-check it (new uploads). Never throws — must not break the gallery. */
export async function registerGallery(env, providerName, source, name) {
  try {
    await ensureSchema(env);
    const now = iso();
    await env.DB.prepare(
      "INSERT INTO mirror_galleries (provider, source, name, added_at, next_check) VALUES (?,?,?,?,?)" +
        " ON CONFLICT(provider, source) DO UPDATE SET name = excluded.name," +
        " next_check = MIN(mirror_galleries.next_check, excluded.next_check)",
    ).bind(providerName, source, String(name || "").slice(0, 200), now, now).run();
  } catch (err) {
    console.error("registerGallery failed", err);
  }
}

export async function markDone(env, providerName, source, ref) {
  await ensureSchema(env);
  await env.DB.prepare("INSERT OR IGNORE INTO mirror_files (provider, source, ref, done_at) VALUES (?,?,?,?)")
    .bind(providerName, source, ref, iso()).run();
}

const GALLERY_FIELDS = new Set(["next_check", "last_run", "files", "ready", "failed", "last_error", "paused"]);
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
  await setGallery(env, { provider: providerName, source }, { paused: paused ? 1 : 0, next_check: iso() });
}

/** One cron run. Galleries are leased (next_check pushed out) while being
 * worked on, so an overlapping run skips them. maxFiles keeps one run well
 * under the per-invocation subrequest limit (~10-20 per file worst case). */
export async function runMirror(env, providers, { budgetMs = 4 * MINUTE, maxFiles = 50 } = {}) {
  await ensureSchema(env);
  const stopAt = Date.now() + budgetMs;
  let left = maxFiles;
  const { results: due } = await env.DB.prepare(
    "SELECT provider, source FROM mirror_galleries WHERE paused = 0 AND next_check <= ? ORDER BY next_check LIMIT 20",
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
      await setGallery(env, g, { last_run: iso(), last_error: d.code, next_check: iso(Date.now() + 60 * MINUTE) });
      continue;
    }
    const { results } = await env.DB.prepare("SELECT ref FROM mirror_files WHERE provider = ? AND source = ?")
      .bind(g.provider, g.source).all();
    const done = new Set(results.map((r) => r.ref));
    let ready = files.filter((f) => done.has(f.id)).length;
    let failed = 0, complete = true, lastError = null;

    for (const f of files) {
      if (done.has(f.id)) continue;
      if (Date.now() >= stopAt || left <= 0) { complete = false; break; }
      left--;
      const name = f.name || f.id;
      const parts = await prepareFile(env, provider, g.provider, { ref: f.id, name, video: isVideo(name) }, null, { stopAt });
      if (Object.values(parts).includes("partial")) { complete = false; break; }
      if (isReady(parts)) {
        await markDone(env, g.provider, g.source, f.id);
        ready++;
      } else {
        failed++;
        lastError = Object.values(parts).find((v) => !OK_PARTS.includes(v))?.code || "LS-PREP-FAIL";
      }
    }
    // Unfinished: continue next run. Failures: retry in 30 min. Done: re-check
    // daily (and right away whenever someone opens the gallery).
    const next = !complete ? Date.now() : failed ? Date.now() + 30 * MINUTE : Date.now() + 24 * 60 * MINUTE;
    await setGallery(env, g, { last_run: iso(), files: files.length, ready, failed, last_error: lastError, next_check: iso(next) });
  }
}
