// R2 mirror of gallery files. "Prepare gallery" in /admin copies every file's
// thumbnail, full-size preview and original bytes into R2 once, at a pace the
// source tolerates; visitors are then served from R2 and never wait on (or use
// up) Google Drive's burst throttling and per-file download limits. Files that
// were never prepared still fall back to the source, as before.
import { HttpError, LuxError, describe, guessType, isVideo } from "./util.js";

// One R2 put takes up to ~5 GiB; anything bigger keeps streaming from the source.
// (Cameras split recordings at 4 GB, so this is rare.)
export const MAX_MIRROR_BYTES = 4.9 * 1024 ** 3;

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

/** Stream a provider download into R2 without buffering it (FixedLengthStream
 * gives R2 the length up front). A cut transfer fails the put, so no partial
 * object is ever stored. Returns "copied" or "too-large". */
async function copyOriginal(env, provider, providerName, ref, name, onBytes) {
  const res = await provider.openDownload(env, ref);
  const length = Number(res.headers.get("content-length")) || 0;
  if (!length) {
    await res.body?.cancel();
    throw new LuxError(502, "LS-SRC-EMPTY", `file=${ref} (no length)`);
  }
  if (length > MAX_MIRROR_BYTES) {
    await res.body.cancel();
    return "too-large";
  }
  let received = 0;
  const counter = new TransformStream({
    transform(chunk, ctl) {
      received += chunk.byteLength;
      onBytes(received, length);
      ctl.enqueue(chunk);
    },
  });
  const fixed = new FixedLengthStream(length);
  const contentType = guessType(name) || res.headers.get("content-type") || "application/octet-stream";
  await Promise.all([
    res.body.pipeThrough(counter).pipeTo(fixed.writable),
    env.CACHE.put(origKey(providerName, ref), fixed.readable, { httpMetadata: { contentType } }),
  ]);
  return "copied";
}

/** Mirror one file. Each part is checked first, so re-running Prepare only
 * fetches what's missing. Never throws: returns {part: "cached" | "copied" |
 * "too-large" | {code, message, ref}} for thumb, full (photos only) and orig. */
export async function prepareFile(env, provider, providerName, { ref, name, video }, onBytes = () => {}) {
  const parts = video ? ["thumb", "orig"] : ["thumb", "full", "orig"];
  const result = {};
  for (const part of parts) {
    const key = part === "orig" ? origKey(providerName, ref) : imageKey(providerName, part, ref);
    try {
      if (await env.CACHE.head(key)) {
        result[part] = "cached";
      } else if (part === "orig") {
        result[part] = await copyOriginal(env, provider, providerName, ref, name, onBytes);
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
const OK_PARTS = ["cached", "copied", "too-large"];
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
      const parts = await prepareFile(env, provider, g.provider, { ref: f.id, name, video: isVideo(name) });
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
