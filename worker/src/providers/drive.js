// Google Drive provider — reads public (link-shared) folders via a server-side
// API key (env.DRIVE_API_KEY). Optionally, downloads and watched-folder scans
// run as the folders' owner instead (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
// GOOGLE_REFRESH_TOKEN, read-only; see tools/google_oauth.py): Google caps
// anonymous downloads of a popular file, not its owner's.
// Interface every provider implements:
//   parseSource(url) · validateRef(ref) · listGallery(env, sourceId)
//   getThumb(env, ref) / getFull(env, ref) -> {bytes, contentType}
//   openDownload(env, ref, range?) -> upstream Response (200/206) with a body stream
import { HttpError, LuxError, sleep } from "../util.js";

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

// ---- owner sign-in (optional) ----
// The access token is cached per isolate as a plain value (not a shared
// promise, which a cancelled request could leave pending). After a failed
// refresh, owner auth is skipped for AUTH_RETRY_MS and the API key is used.
const AUTH_RETRY_MS = 5 * 60_000;
let ownerAccess = null;      // { token, expires }
let ownerFailedUntil = 0;

export const ownerAuthConfigured = (env) =>
  !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);

async function ownerToken(env, { force = false } = {}) {
  if (!force && ownerAccess && ownerAccess.expires > Date.now() + 60_000) return ownerAccess.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const reason = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`;
    ownerAccess = null;
    ownerFailedUntil = Date.now() + AUTH_RETRY_MS;
    throw new LuxError(503, "LS-DRV-AUTH", `owner token refresh failed: ${reason}`);
  }
  const data = await res.json();
  ownerAccess = { token: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return ownerAccess.token;
}

/** Bearer header when owner sign-in is set up and working, else null (use the API key). */
async function ownerHeaders(env, opts) {
  if (!ownerAuthConfigured(env) || Date.now() < ownerFailedUntil) return null;
  try {
    return { Authorization: `Bearer ${await ownerToken(env, opts)}` };
  } catch {
    return null;   // already logged as LS-DRV-AUTH; fall back to the API key
  }
}

async function driveGet(env, path, params, { owner = false } = {}) {
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
  const headers = (owner && (await ownerHeaders(env))) || {};
  if (!headers.Authorization) {
    if (!env.DRIVE_API_KEY) throw new HttpError(500, "Server is missing DRIVE_API_KEY");
    url.searchParams.set("key", env.DRIVE_API_KEY);
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers });
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
  // Each entry carries `path`: subfolder names from the root down to it (folder view).
  const queue = [{ id: rootId, path: [] }];
  let visited = 0;
  while (queue.length && visited < MAX_FOLDERS) {
    const { id, path } = queue.shift();
    visited++;
    for (const child of await listChildren(env, id)) {
      const mime = child.mimeType || "";
      if (mime === FOLDER_MIME) queue.push({ id: child.id, path: [...path, child.name || "Untitled"] });
      else if (mime.startsWith("image/") || mime.startsWith("video/")) media.push({ ...child, folder: path });
    }
  }
  return media;
}

/** Folders directly inside a watched folder, for mirror-at-delivery (mirror.js runWatch). */
export async function listSubfolders(env, parentId) {
  const q = `'${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const all = [];
  let pageToken = "";
  do {
    const params = { q, fields: "nextPageToken,files(id,name,createdTime)", pageSize: 1000 };
    if (pageToken) params.pageToken = pageToken;
    const data = await driveGet(env, "files", params, { owner: true });
    all.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return all;
}

export async function folderName(env, id) {
  return (await driveGet(env, `files/${id}`, { fields: "name" }, { owner: true })).name || "";
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

// Two public, unauthenticated image endpoints for a link-shared file (both give
// a frame for videos too). lh3 is Google's image CDN and copes with bursts from
// Cloudflare's shared IPs much better than drive.google.com/thumbnail, which
// answers them with 403s or an HTML "sorry" page, so it's only the fallback.
const imageUrls = (ref, width) => [
  `https://lh3.googleusercontent.com/d/${ref}=w${width}`,
  `https://drive.google.com/thumbnail?id=${ref}&sz=w${width}`,
];

// No cross-request concurrency cap here on purpose: a slot held by a request the
// browser cancelled (scrolling, closed tab) is never released, and every later
// thumbnail in that isolate then hangs until Cloudflare kills it (error 1101).
async function fetchPublicImage(fileRef, width) {
  let res;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    for (const url of imageUrls(fileRef, width)) {
      res = await fetch(url, { redirect: "follow" });
      const type = res.headers.get("content-type") || "";
      // A throttled request can come back 200 with an HTML page; only image
      // bytes count as success (and only those get cached in R2).
      if (res.status === 200 && type.startsWith("image/")) {
        return { bytes: await res.arrayBuffer(), contentType: type };
      }
      await res.body?.cancel();
      console.warn(`Drive image ${fileRef} ${new URL(url).host} -> ${res.status} ${type} (attempt ${attempt + 1})`);
    }
    // The last response is drive.google.com's; it answers bursts with 403 as well as 429.
    const transient = res.status === 200 || res.status === 403 || isTransient(res.status, "");
    if (!transient || attempt === MAX_ATTEMPTS - 1) break;
    await backoff(attempt, res);
  }
  if (res.status === 200 || res.status === 403 || res.status === 429 || res.status >= 500) {
    throw new LuxError(503, "LS-DRV-RATE", `image ${fileRef} status=${res.status}`);
  }
  throw new LuxError(404, "LS-DRV-GONE", `image ${fileRef} status=${res.status}`);
}

export const getThumb = (env, ref) => fetchPublicImage(ref, 600);
export const getFull = (env, ref) => fetchPublicImage(ref, 2200);

/** Open a file for download (optionally ranged). Deliberately the API v3
 * alt=media endpoint, not drive.google.com/uc?export=download: past a few MB
 * that URL serves an HTML "can't scan for viruses" page with a 200. Retries
 * happen here, before any byte is sent. */
export async function openDownload(env, fileRef, range = null) {
  let auth = await ownerHeaders(env);
  if (!auth && !env.DRIVE_API_KEY) throw new LuxError(500, "LS-DRV-CFG", "DRIVE_API_KEY is not set");
  const base = `https://www.googleapis.com/drive/v3/files/${fileRef}?alt=media`;
  let switched = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await pace(env);
    const url = auth ? `${base}&supportsAllDrives=true` : `${base}&key=${env.DRIVE_API_KEY}`;
    const headers = { ...(range ? { Range: range } : {}), ...(auth || {}) };
    const res = await fetch(url, { headers, redirect: "follow" });
    if (res.status === 200 || res.status === 206) return res;
    const reason = await errorReason(res);
    const ownerRefused = res.status === 401 || res.status === 404 ||
      (res.status === 403 && reason !== "downloadQuotaExceeded" && !RATE_LIMIT_REASONS.has(reason));
    if (auth && ownerRefused && !switched) {
      // 401: the token expired or was revoked, so refresh it. 403/404: the owner
      // account can't see this file, so use the public API key. Once only, and it
      // doesn't use up an attempt.
      switched = true;
      attempt--;
      console.warn(`Drive owner download ${fileRef} -> ${res.status} ${reason || ""}; retrying ${res.status === 401 ? "with a fresh token" : "with the API key"}`);
      auth = res.status === 401 ? await ownerHeaders(env, { force: true }) : null;
      if (!auth && !env.DRIVE_API_KEY) throw new LuxError(500, "LS-DRV-CFG", "DRIVE_API_KEY is not set");
      continue;
    }
    const ctx = `file=${fileRef} status=${res.status} reason=${reason || "-"}${auth ? " (owner)" : ""}`;
    console.warn(`Drive download ${ctx} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    // Google's per-file download cap; retrying only digs deeper.
    if (reason === "downloadQuotaExceeded") throw new LuxError(503, "LS-DRV-FILE", `file=${fileRef}`);
    if (!isTransient(res.status, reason)) throw new LuxError(404, "LS-DRV-GONE", ctx);
    if (attempt === MAX_ATTEMPTS - 1) throw new LuxError(503, "LS-DRV-RATE", ctx);
    await backoff(attempt, res);
  }
  throw new LuxError(503, "LS-DRV-RATE", `file=${fileRef} no attempts left`);
}
