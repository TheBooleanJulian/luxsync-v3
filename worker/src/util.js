// Small shared helpers: error types, filenames, email validation, auth, hashing.

// Client-facing error codes. Keep in sync with the browser's list in index.html
// (codes starting LS-JOB / LS-NET-OFF / LS-LIMIT are raised in the browser).
const MESSAGES = {
  "LS-DRV-RATE": "Google Drive is temporarily limiting requests. Wait a minute, then try again.",
  "LS-DRV-FILE": "Google has temporarily limited downloads of this file. Try again in a few hours.",
  "LS-DRV-GONE": "This file is missing or is no longer shared publicly.",
  "LS-DRV-CFG": "The server is not set up to talk to Google Drive.",
  "LS-NET-CUT": "The connection to the source dropped mid-download.",
  "LS-SRC-EMPTY": "The source returned an empty file.",
  "LS-PREP-RANGE": "The source didn't return the requested part of a file while it was being copied.",
  "LS-DRV-AUTH": "The server's Google sign-in failed, so it used the public link instead.",
  "LS-ZIP-FAIL": "The zip was interrupted before it finished.",
};

/** An error that becomes a JSON `{detail}` response, like FastAPI's HTTPException. */
export class HttpError extends Error {
  constructor(status, detail, headers = {}) {
    super(typeof detail === "string" ? detail : detail?.message || "error");
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

// ---------- error console ----------
// Every LuxError and describe() also lands in this queue, and
// errorlog.flushErrors() writes it to D1 (error_log, shown in /admin) at the
// end of a request, zip, prepare or cron run. It's a plain array, not a
// promise or lock, so a cancelled request can't wedge it (see the note at
// the bottom of this file). Entries carry their own context, so it doesn't
// matter which request in the isolate flushes them.
const QUEUE_MAX = 500;
// A throttling storm (e.g. Google refusing thumbnails) can throw hundreds of
// errors a minute; past this many server errors per minute per isolate, the
// rest are counted and logged as one LS-LOG-SAMPLED row instead.
const PER_MINUTE = 60;
let windowStart = 0, inWindow = 0, skipped = 0;
export const errorQueue = [];

export function recordError(entry, now = Date.now()) {
  if (now - windowStart >= 60_000) {
    if (skipped) {
      errorQueue.push({ ts: new Date(windowStart + 60_000).toISOString(), origin: "server", code: "LS-LOG-SAMPLED",
        context: `${skipped} more server errors in the minute from ${new Date(windowStart).toISOString()} were not logged` });
    }
    windowStart = now; inWindow = 0; skipped = 0;
  }
  if (entry.origin !== "client" && ++inWindow > PER_MINUTE) { skipped++; return; }
  errorQueue.push({ ts: new Date(now).toISOString(), origin: "server", ...entry });
  if (errorQueue.length > QUEUE_MAX) errorQueue.splice(0, errorQueue.length - QUEUE_MAX);
}

/** Drop a queued error that turned out to be expected (e.g. a file with no preview). */
export function discardError(ref) {
  const i = ref ? errorQueue.findIndex((x) => x.ref === ref) : -1;
  if (i >= 0) errorQueue.splice(i, 1);
}

/** Add details (path, gallery, where it happened) to a queued error by its ref. */
export function annotateError(ref, fields) {
  const e = ref && errorQueue.find((x) => x.ref === ref);
  if (!e) return;
  for (const [k, v] of Object.entries(fields)) {
    if (!v) continue;
    if (k === "context") e.context = e.context ? `${v} · ${e.context}` : v;
    else if (!e[k]) e[k] = v;
  }
}

/** HttpError whose detail is {code, message, ref}. The ref is logged next to
 * the details so a visitor's screenshot can be matched to the exact log line. */
export class LuxError extends HttpError {
  constructor(status, code, context = "") {
    const ref = randomRef();
    super(status, { code, message: MESSAGES[code], ref });
    console.warn(`${code} ref=${ref} status=${status} ${context}`);
    recordError({ code, ref, status, context });
  }
}

function randomRef() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** {code, message, ref} for any thrown value, logging the ones that weren't
 * already a LuxError. `fallback` is the code for a non-HTTP error. */
export function describe(exc, context = "", fallback = "LS-ZIP-FAIL") {
  if (exc instanceof LuxError) {
    annotateError(exc.detail.ref, { context });
    return exc.detail;
  }
  const ref = randomRef();
  let code, message;
  if (exc instanceof HttpError) {
    code = `LS-HTTP-${exc.status}`;
    message = typeof exc.detail === "string" ? exc.detail : exc.message;
  } else {
    code = fallback;
    message = MESSAGES[code];
  }
  console.warn(`${code} ref=${ref} ${context}: ${exc && exc.message}`);
  recordError({ code, ref, status: exc?.status ?? null, context: `${context}: ${exc && exc.message}` });
  return { code, message, ref };
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;

/** Lowercased email if it looks valid, else null. */
export function normalizeEmail(raw) {
  const email = String(raw ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export function requireEmail(raw) {
  const email = normalizeEmail(raw);
  if (email === null) throw new HttpError(400, "A valid email is required to download");
  return email;
}

/** Content-Disposition for a gallery/visitor-supplied filename. Headers are
 * latin-1, so send an ASCII fallback plus the RFC 5987 UTF-8 form. */
export function contentDisposition(filename) {
  const clean = String(filename).replace(/[\r\n"\\]/g, "");
  const fallback = clean.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(clean)}`;
}

function encodeRfc5987(s) {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Give repeated filenames (Drive allows duplicates in one folder) a
 * " (2)", " (3)", ... suffix so they don't collide as zip entries. */
export function dedupeNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    if (count === 1) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
  });
}

export function sanitizeZipName(name) {
  let n = String(name ?? "").trim();
  n = n.replace(/[\r\n"\\/:*?<>|]/g, "");
  n = n.trim().replace(/(\.zip)+$/i, ""); // we append .zip ourselves
  n = n.replace(/^[. ]+|[. ]+$/g, "");
  return n || "gallery";
}

const MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
  avi: "video/x-msvideo", mkv: "video/x-matroska",
  // DJI (.lrf) and GoPro/Insta360 (.lrv) low-res proxies are plain MP4s.
  lrf: "video/mp4", lrv: "video/mp4",
};

export function guessType(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || "");
  return (m && MIME[m[1].toLowerCase()]) || null;
}

export function isVideo(name) {
  return (guessType(name) || "").startsWith("video/");
}

/** The Range header to forward for a resumable download, or null to send the
 * whole file. Honours If-Range: a resume validated against a different ETag
 * (or a date, since we never send Last-Modified) restarts from byte 0. */
export function resumeRange(request, etag) {
  const range = request.headers.get("Range");
  if (!range) return null;
  const ifRange = request.headers.get("If-Range");
  if (ifRange && ifRange !== etag) return null;
  return range;
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "";
}

export async function hashIp(env, ip) {
  const salt = env.IP_HASH_SALT || env.ADMIN_PASSWORD || "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (hash both sides so lengths match). */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** HTTP Basic check for /admin. ADMIN_PASSWORD unset = admin disabled (404).
 * ADMIN_USERNAME is optional: when set it must match too. */
export async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(404, "Not found");
  const challenge = { "WWW-Authenticate": 'Basic realm="LuxSync admin"' };
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) throw new HttpError(401, "Unauthorized", challenge);
  let user = "", pass = "";
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
    const i = decoded.indexOf(":");
    user = decoded.slice(0, i);
    pass = decoded.slice(i + 1);
  } catch {
    throw new HttpError(401, "Unauthorized", challenge);
  }
  const passOk = await safeEqual(pass, env.ADMIN_PASSWORD);
  const userOk = !env.ADMIN_USERNAME || (await safeEqual(user, env.ADMIN_USERNAME));
  if (!(passOk && userOk)) throw new HttpError(401, "Unauthorized", challenge);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// No module-level Semaphore/queue: Workers share an isolate across requests, and
// a slot held by a cancelled request is never released (hangs -> error 1101).
