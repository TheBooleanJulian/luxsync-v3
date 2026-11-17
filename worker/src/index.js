// LuxSync v3 — Cloudflare Worker backend (port of the FastAPI app in ../main.py).
//
// Keeps every gallery source's API credentials server-side only. Provider-agnostic
// endpoints dispatch to src/providers/*. Folder listings and thumbnails/full
// images/videos are cached in R2 (env.CACHE); the download log lives in D1
// (env.DB); /, /static/* are served by the assets binding without running this
// Worker. Responses keep the shapes index.html and admin.html already expect.
import * as cache from "./cache.js";
import * as dl from "./downloads.js";
import { newJob, readJobs, saveJob } from "./jobs.js";
import { openSource, origKey, prepareResponse } from "./mirror.js";
import * as drive from "./providers/drive.js";
import * as dropbox from "./providers/dropbox.js";
import { generatorToStream, zipStream } from "./zip.js";
import {
  HttpError, LuxError, clientIp, contentDisposition, dedupeNames, describe, guessType, isVideo, json,
  requireAdmin, requireEmail, resumeRange, sanitizeZipName, sleep,
} from "./util.js";
import adminHtml from "../../admin.html";

const PROVIDERS = { drive, dropbox };
const MAX_ZIP_FILES = 200;
const IMMUTABLE = "public, max-age=2592000, immutable";
// Unprepared videos are tee'd into R2 while they stream to the client; cap the
// size so a slow client can't make the tee buffer unbounded in the Worker's
// 128 MB. Bigger files are mirrored by Prepare gallery (src/mirror.js).
const MAX_VIDEO_CACHE_BYTES = 64 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new HttpError(400, "Unknown provider");
  return p;
}

function resolveSource(url) {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const id = p.parseSource(url);
    if (id) return [name, id];
  }
  throw new HttpError(400, "Could not recognize that link. Paste a public Google Drive folder or Dropbox shared folder link.");
}

/** Per-IP rate limit via a Workers Rate Limiting binding (RL_*). Absent binding = unlimited (local dev). */
async function limit(env, request, name) {
  const binding = env[`RL_${name}`];
  if (!binding) return;
  const { success } = await binding.limit({ key: clientIp(request) || "unknown" });
  if (!success) throw new HttpError(429, "Rate limit exceeded");
}

// ---------- gallery ----------
async function getGallery(request, env) {
  await limit(env, request, "GALLERY");
  let payload;
  try { payload = await request.json(); } catch { throw new HttpError(422, "Invalid JSON body"); }

  let providerName, sourceId;
  if (payload.provider && payload.source) {
    providerName = payload.provider;
    sourceId = payload.source;
    getProvider(providerName);
  } else if (payload.url) {
    [providerName, sourceId] = resolveSource(payload.url);
  } else {
    throw new HttpError(400, "Missing url");
  }
  const provider = PROVIDERS[providerName];
  provider.validateRef(sourceId);

  const key = `${providerName}/folder-cache/${sourceId}.json`;
  const ttl = Number(env.FOLDER_CACHE_TTL_SECONDS || 600);
  // payload.refresh skips the cached listing (e.g. Drive was still syncing)
  const cached = payload.refresh ? null : await cache.getJson(env, key, ttl);
  if (cached) return json({ provider: providerName, source: sourceId, ...cached });

  const result = await provider.listGallery(env, sourceId);
  await cache.putJson(env, key, result);
  return json({ provider: providerName, source: sourceId, ...result });
}

// ---------- thumbnails / full images ----------
async function serveImage(request, env, providerName, fileRef, kind) {
  await limit(env, request, kind === "thumb" ? "THUMB" : "FULL");
  const provider = getProvider(providerName);
  provider.validateRef(fileRef);
  const key = `${providerName}/${kind}/${fileRef}`;

  const hit = await cache.getObject(env, key);
  if (hit) {
    return new Response(hit.body, { headers: { "Content-Type": hit.httpMetadata?.contentType || "image/jpeg", "Cache-Control": IMMUTABLE } });
  }
  const { bytes, contentType } = await (kind === "thumb" ? provider.getThumb : provider.getFull)(env, fileRef);
  await cache.putObject(env, key, bytes, contentType);
  return new Response(bytes, { headers: { "Content-Type": contentType, "Cache-Control": IMMUTABLE } });
}

// ---------- video streaming ----------
/** Status, length/range headers and X-LuxSync-Source copied from openSource's response. */
function passThroughHeaders(res, base) {
  const headers = { ...base, "Accept-Ranges": "bytes" };
  for (const h of ["content-length", "content-range", "x-luxsync-source"]) if (res.headers.get(h)) headers[h] = res.headers.get(h);
  return headers;
}

async function streamVideo(request, env, ctx, providerName, fileRef, url) {
  await limit(env, request, "STREAM");
  const provider = getProvider(providerName);
  provider.validateRef(fileRef);
  const guessed = guessType(url.searchParams.get("name") || "") || "video/mp4";

  // Ranges are forwarded so playback starts immediately (and Safari, which
  // refuses to play without a ranged response, works).
  const res = await openSource(env, provider, providerName, fileRef, request.headers.get("Range"));
  const headers = passThroughHeaders(res, { "Content-Type": guessed, "Cache-Control": IMMUTABLE });
  const length = Number(res.headers.get("content-length"));
  // An unprepared short clip is mirrored on its first whole-file play; longer
  // ones wait for Prepare gallery.
  if (res.headers.get("x-luxsync-source") === "source" && res.status === 200 && length > 0 && length <= MAX_VIDEO_CACHE_BYTES) {
    const [toClient, toCache] = res.body.tee();
    const fixed = new FixedLengthStream(length);
    toCache.pipeTo(fixed.writable).catch(() => {});
    ctx.waitUntil(cache.putObject(env, origKey(providerName, fileRef), fixed.readable, guessed));
    return new Response(toClient, { headers });
  }
  return new Response(res.body, { status: res.status, headers });
}

// ---------- downloads ----------
/** Download a whole (non-video) file into memory, retrying if the source cuts the
 * transfer off partway. Fetching whole lets us retry and send a correct
 * Content-Length, so a short transfer fails loudly instead of saving a
 * truncated "corrupt" photo. */
async function fetchBytes(env, provider, providerName, fileRef, { attempts = 3, progress } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (progress) progress(0);
    try {
      const res = await openSource(env, provider, providerName, fileRef);
      const expected = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (progress) progress(received);
      }
      if (expected && received !== expected) throw new Error(`short read ${received}/${expected}`);
      const out = new Uint8Array(received);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    } catch (err) {
      if (err instanceof HttpError) throw err; // real HTTP errors already carry a code; don't retry
      console.warn(`transfer cut for ${fileRef} (attempt ${attempt + 1}/${attempts}): ${err.message}`);
      if (attempt === attempts - 1) throw new LuxError(503, "LS-NET-CUT", `file=${fileRef}`);
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function downloadFile(request, env, providerName, fileRef, url) {
  await limit(env, request, "DOWNLOAD");
  const provider = getProvider(providerName);
  provider.validateRef(fileRef);
  const q = url.searchParams;
  const email = requireEmail(q.get("email"));
  const name = q.get("name") || "download";
  // Videos are resumable: a phone that pauses a big download (screen lock,
  // app switch, flaky signal) comes back with a Range for the rest. The file
  // ID is the validator; a resume is logged once, by its first request.
  const etag = `"${fileRef}"`;
  const range = isVideo(name) ? resumeRange(request, etag) : null;
  if (!range || /^bytes=0-/.test(range)) {
    await dl.logDownload(env, {
      email, optin: Number(q.get("optin") || 0) === 1, provider: providerName, source: q.get("source") || "",
      galleryName: q.get("gallery") || "", kind: "photo", filenames: [name], ip: clientIp(request),
    });
  }

  const headers = { "Content-Type": "application/octet-stream", "Content-Disposition": contentDisposition(name) };
  if (isVideo(name)) {
    const res = await openSource(env, provider, providerName, fileRef, range);
    return new Response(res.body, { status: res.status, headers: passThroughHeaders(res, { ...headers, ETag: etag }) });
  }
  const data = await fetchBytes(env, provider, providerName, fileRef);
  if (!data.length) throw new LuxError(502, "LS-SRC-EMPTY", `file=${fileRef}`);
  return new Response(data, { headers });
}

async function downloadZip(request, env, ctx) {
  await limit(env, request, "ZIP");
  const form = await request.formData();
  const field = (n, d = "") => (form.get(n) ?? d);
  const providerName = field("provider", "drive");
  const provider = getProvider(providerName);
  const email = requireEmail(field("email"));
  const kind = field("kind", "selected");
  if (kind !== "selected" && kind !== "all") throw new HttpError(400, "Invalid kind");

  let fileList;
  try { fileList = JSON.parse(field("files")); } catch { throw new HttpError(400, "Invalid file list"); }
  if (!Array.isArray(fileList) || !fileList.length) throw new HttpError(400, "No files given");
  if (fileList.length > MAX_ZIP_FILES) throw new HttpError(400, `Too many files (max ${MAX_ZIP_FILES} per zip)`);

  const refs = [];
  let names = [];
  for (const item of fileList) {
    const ref = item?.id || "";
    provider.validateRef(ref);
    refs.push(ref);
    names.push(item.name || ref);
  }
  names = dedupeNames(names);

  // A very large "Download All" is sent as several zips; log it once (part 0)
  // with the full file count rather than once per chunk.
  if (Number(field("part", 0)) === 0) {
    await dl.logDownload(env, {
      email, optin: Number(field("optin", 0)) === 1, provider: providerName, source: field("source"),
      galleryName: field("gallery_name"), kind, filenames: names,
      fileCount: Math.max(Number(field("total", 0)) || 0, names.length), ip: clientIp(request),
    });
  }

  const job = newJob(field("job_id"), refs.length);
  const track = (force = false) => ctx.waitUntil(saveJob(job, force));
  const setBytes = (n) => { job.bytes = n; track(); };

  async function* videoContent(i, ref, res) {
    // Videos stream straight through (too big to buffer), so a failure partway
    // can't be skipped cleanly and ends the zip.
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        job.bytes += value.length;
        track();
        yield value;
      }
    } catch (err) {
      job.st[i] = "f";
      job.fail[i] = describe(err, `zip member ${names[i]}`);
      throw err;
    }
  }

  async function* members() {
    // A photo that can't be fetched is skipped, not fatal: aborting would leave
    // the visitor with an invalid zip. Skipped files are reported in the panel
    // and listed in _MISSING_FILES.txt inside the zip.
    const now = new Date();
    const missing = [];
    for (let i = 0; i < refs.length; i++) {
      job.st[i] = "a";
      job.bytes = 0;
      track(true);
      if (isVideo(names[i])) {
        try {
          const res = await openSource(env, provider, providerName, refs[i]);
          yield { name: names[i], date: now, data: videoContent(i, refs[i], res), size: Number(res.headers.get("content-length")) || 0 };
        } catch (err) {
          job.st[i] = "f";
          job.fail[i] = describe(err, `zip member ${names[i]}`);
          throw err;
        }
        job.st[i] = "d";
        continue;
      }
      let data;
      try {
        data = await fetchBytes(env, provider, providerName, refs[i], { progress: setBytes });
      } catch (err) {
        job.st[i] = "f";
        const fail = (job.fail[i] = describe(err, `zip member ${names[i]}`));
        missing.push(`${names[i]}  [${fail.code} ref ${fail.ref}]`);
        continue;
      }
      yield { name: names[i], date: now, data };
      job.st[i] = "d"; // reached once the zip has consumed this member
    }
    if (missing.length) {
      const note =
        "These files could not be fetched and are NOT in this zip.\n" +
        "Try downloading them again, or send the codes below to your photographer.\n\n" +
        missing.join("\n") + "\n";
      yield { name: "_MISSING_FILES.txt", date: now, data: new TextEncoder().encode(note) };
    }
  }

  async function* trackedZip() {
    try {
      yield* zipStream(members());
      job.state = "done";
      await saveJob(job, true);
    } catch (err) {
      job.state = "error";
      job.error = err instanceof Error
        ? describe(err, "zip")
        : { code: "LS-ZIP-FAIL", message: "The download was cancelled or the connection closed.", ref: "" };
      await saveJob(job, true);
      throw err;
    }
  }

  const zipName = `${sanitizeZipName(field("zip_name", "gallery"))}.zip`;
  return new Response(generatorToStream(trackedZip()), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": contentDisposition(zipName) },
  });
}

// ---------- admin ----------
const csvCell = (v) => {
  // Emails/filenames are visitor-supplied; stop spreadsheets treating them as formulas.
  const text = String(v);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
};
const csvRow = (cells) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");

async function adminRoutes(request, env, ctx, url) {
  await requireAdmin(request, env);
  if (url.pathname === "/api/admin/prepare") {
    // One call per file and a gallery can have hundreds, so this route skips
    // RL_ADMIN; it's behind admin auth and paced against the source anyway.
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
    let body;
    try { body = await request.json(); } catch { throw new HttpError(422, "Invalid JSON body"); }
    const providerName = body.provider || "drive";
    const provider = getProvider(providerName);
    provider.validateRef(body.id);
    const name = String(body.name || "");
    return prepareResponse(env, ctx, provider, providerName, { ref: body.id, name, video: isVideo(name) });
  }
  if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
  await limit(env, request, "ADMIN");
  const q = (url.searchParams.get("q") || "").trim();
  switch (url.pathname) {
    case "/admin":
      return new Response(adminHtml, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    case "/api/admin/stats":
      return json(await dl.stats(env));
    case "/api/admin/downloads": {
      const limitN = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
      const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
      return json(await dl.listDownloads(env, url.searchParams.get("view") || "gallery", q, limitN, offset));
    }
    case "/api/admin/emails":
      return json(await dl.listEmails(env, q));
    case "/api/admin/export.csv": {
      const view = url.searchParams.get("view") || "emails";
      const rows = [];
      if (view === "emails") {
        rows.push(csvRow(["email", "newsletter_optin", "downloads", "galleries", "first_seen", "last_seen"]));
        for (const r of await dl.listEmails(env)) {
          rows.push(csvRow([csvCell(r.email), r.optin, r.downloads, r.galleries, r.first_seen, r.last_seen]));
        }
      } else {
        rows.push(csvRow(["time_utc", "email", "newsletter_optin", "gallery", "type", "files", "filenames"]));
        const all = [...(await dl.listDownloads(env, "photo", "", 1e6)).items, ...(await dl.listDownloads(env, "gallery", "", 1e6)).items];
        for (const r of all) {
          rows.push(csvRow([r.ts, csvCell(r.email), r.optin, csvCell(r.gallery_name), r.kind, r.file_count, csvCell(r.filenames.join("; "))]));
        }
      }
      return new Response(rows.join("\r\n") + "\r\n", {
        headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="luxsync-${view}.csv"` },
      });
    }
  }
  throw new HttpError(404, "Not found");
}

// ---------- router ----------
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  let m;

  if (path === "/admin" || path.startsWith("/api/admin/")) return adminRoutes(request, env, ctx, url);
  if (path === "/api/gallery" && method === "POST") return getGallery(request, env);
  if (path === "/api/download-zip" && method === "POST") return downloadZip(request, env, ctx);
  if (path === "/api/download-progress" && method === "GET") {
    await limit(env, request, "PROGRESS");
    return json(await readJobs(url.searchParams.get("jobs") || ""), 200, { "Cache-Control": "no-store" });
  }
  if (method === "GET" && (m = /^\/api\/(thumb|full)\/([^/]+)\/([^/]+)$/.exec(path))) return serveImage(request, env, m[2], m[3], m[1]);
  if (method === "GET" && (m = /^\/api\/stream\/([^/]+)\/([^/]+)$/.exec(path))) return streamVideo(request, env, ctx, m[1], m[2], url);
  if (method === "GET" && (m = /^\/api\/download\/([^/]+)\/([^/]+)$/.exec(path))) return downloadFile(request, env, m[1], m[2], url);
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    let res;
    try {
      res = await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        const body = err.status === 429 ? { error: err.detail } : { detail: err.detail };
        res = json(body, err.status, err.headers);
      } else {
        console.error("Unhandled error", err);
        res = json({ detail: "Internal Server Error" }, 500);
      }
    }
    // Public gallery data gated only by knowing the source folder id, so a wildcard origin is fine.
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },
};
