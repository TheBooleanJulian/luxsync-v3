// Google Drive provider — reads public (link-shared) folders via a server-side
// API key (env.DRIVE_API_KEY). Interface every provider implements:
//   parseSource(url) · validateRef(ref) · listGallery(env, sourceId)
//   getThumb(env, ref) / getFull(env, ref) -> {bytes, contentType}
//   openDownload(env, ref, range?) -> upstream Response (200/206) with a body stream
import { HttpError, LuxError, Semaphore, sleep } from "../util.js";

const DRIVE_ID_RE = /^[a-zA-Z0-9_-]{10,}$/;
const URL_PATTERNS = [/\/folders\/([a-zA-Z0-9_-]{10,})/, /[?&]id=([a-zA-Z0-9_-]{10,})/];
const FOLDER_MIME = "application/vnd.google-apps.folder";
// Safety cap on subfolders visited per gallery walk (guards against a circular tree).
const MAX_FOLDERS = 300;

export function parseSource(url) {
  for (const re of URL_PATTERNS) {
    const m = re.exec(url);
    if (m) return m[1];
  }
  const bare = url.trim();
  return DRIVE_ID_RE.test(bare) ? bare : null; // bare ID pasted directly
}

export function validateRef(ref) {
  if (!DRIVE_ID_RE.test(ref || "")) throw new HttpError(400, "Invalid ID");
}

async function driveGet(env, path, params) {
  if (!env.DRIVE_API_KEY) throw new HttpError(500, "Server is missing DRIVE_API_KEY");
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: env.DRIVE_API_KEY })) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (res.status !== 200) {
    let detail = "Drive API request failed";
    try { detail = (await res.json()).error?.message || detail; } catch { /* keep default */ }
    throw new HttpError(res.status < 500 ? res.status : 502, detail);
  }
  return res.json();
}

async function listChildren(env, parentId) {
  const fields = "nextPageToken,files(id,name,imageMediaMetadata,videoMediaMetadata,createdTime,modifiedTime,mimeType)";
  const q = `'${parentId}' in parents and trashed = false`;
  const all = [];
  let pageToken = "";
  do {
    const params = { q, fields, pageSize: 1000 };
    if (pageToken) params.pageToken = pageToken;
    const data = await driveGet(env, "files", params);
    all.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return all;
}

/** Walk the folder tree gathering every image/video, directly inside the root
 * or in any subfolder (galleries are often per-person subfolders). */
async function collectMedia(env, rootId) {
  const media = [];
  const queue = [rootId];
  let visited = 0;
  while (queue.length && visited < MAX_FOLDERS) {
    const folderId = queue.shift();
    visited++;
    for (const child of await listChildren(env, folderId)) {
      const mime = child.mimeType || "";
      if (mime === FOLDER_MIME) queue.push(child.id);
      else if (mime.startsWith("image/") || mime.startsWith("video/")) media.push(child);
    }
  }
  return media;
}

export async function listGallery(env, sourceId) {
  const folder = await driveGet(env, `files/${sourceId}`, { fields: "name" });
  const files = await collectMedia(env, sourceId);
  return { name: folder.name || "Gallery", files };
}

// ---- quota protection ----
// Visitors share one API key, so to Drive it looks like one heavy user, and Drive
// throttles request *bursts* (403 userRateLimitExceeded / 429) long before the
// documented quota. So: pace request starts, retry only transient errors
// (honouring Retry-After, with jitter), and log Google's real error reason.
// Isolates don't share memory, so pacing is per isolate — a zip is one request
// fetching sequentially, which is where bursts come from.
const MIN_INTERVAL_MS = 120;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_REASONS = new Set(["userRateLimitExceeded", "rateLimitExceeded", "sharingRateLimitExceeded"]);
let lastRequest = 0;
const thumbSlots = new Semaphore(10);

async function pace(env) {
  const interval = Number(env.DRIVE_MIN_INTERVAL_MS ?? MIN_INTERVAL_MS);
  const start = Math.max(Date.now(), lastRequest + interval);
  const wait = start - Date.now();
  lastRequest = start;
  if (wait > 0) await sleep(wait);
}

async function errorReason(res) {
  try {
    const body = await res.json();
    return body.error?.errors?.[0]?.reason || "";
  } catch {
    return "";
  }
}

const isTransient = (status, reason) => [429, 500, 502, 503, 504].includes(status) || RATE_LIMIT_REASONS.has(reason);

async function backoff(attempt, res) {
  const retryAfter = Number(res.headers.get("retry-after"));
  const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) : 2 ** attempt;
  await sleep(delay * 1000 + Math.random() * 500);
}

async function fetchPublicImage(fileRef, size) {
  const url = `https://drive.google.com/thumbnail?id=${fileRef}&sz=${size}`;
  return thumbSlots.run(async () => {
    let res;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      res = await fetch(url, { redirect: "follow" });
      if (res.status === 200) {
        return { bytes: await res.arrayBuffer(), contentType: res.headers.get("content-type") || "image/jpeg" };
      }
      console.warn(`Drive thumbnail ${fileRef} -> ${res.status} (attempt ${attempt + 1})`);
      if (!isTransient(res.status, "") || attempt === MAX_ATTEMPTS - 1) break;
      await backoff(attempt, res);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new LuxError(503, "LS-DRV-RATE", `thumbnail ${fileRef} status=${res.status}`);
    }
    throw new LuxError(404, "LS-DRV-GONE", `thumbnail ${fileRef} status=${res.status}`);
  });
}

export const getThumb = (env, ref) => fetchPublicImage(ref, "w600");
export const getFull = (env, ref) => fetchPublicImage(ref, "w2200");

/** Open a file for download (optionally ranged). Deliberately the API v3
 * alt=media endpoint, not drive.google.com/uc?export=download: past a few MB
 * that URL serves an HTML "can't scan for viruses" page with a 200. Retries
 * happen here, before any byte is sent. */
export async function openDownload(env, fileRef, range = null) {
  if (!env.DRIVE_API_KEY) throw new LuxError(500, "LS-DRV-CFG", "DRIVE_API_KEY is not set");
  const url = `https://www.googleapis.com/drive/v3/files/${fileRef}?alt=media&key=${env.DRIVE_API_KEY}`;
  const headers = range ? { Range: range } : {};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await pace(env);
    const res = await fetch(url, { headers, redirect: "follow" });
    if (res.status === 200 || res.status === 206) return res;
    const reason = await errorReason(res);
    const ctx = `file=${fileRef} status=${res.status} reason=${reason || "-"}`;
    console.warn(`Drive download ${ctx} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    // Google's per-file download cap; retrying only digs deeper.
    if (reason === "downloadQuotaExceeded") throw new LuxError(503, "LS-DRV-FILE", `file=${fileRef}`);
    if (!isTransient(res.status, reason)) throw new LuxError(404, "LS-DRV-GONE", ctx);
    if (attempt === MAX_ATTEMPTS - 1) throw new LuxError(503, "LS-DRV-RATE", ctx);
    await backoff(attempt, res);
  }
}
