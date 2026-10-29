// Dropbox provider — reads public shared-folder links via one server-owned app
// token (refreshed automatically), so visitors never need a Dropbox account.
// Env: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN (or, for quick
// tests, DROPBOX_ACCESS_TOKEN which expires after a few hours).
// Note: like the Python version this has not been exercised against a live
// Dropbox app — test it against a real shared folder before relying on it.
import { HttpError } from "../util.js";

const URL_RE = /https?:\/\/(?:www\.)?dropbox\.com\/(?:scl\/fo|sh)\/\S+/i;
const REF_RE = /^[A-Za-z0-9_-]+$/;
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|heic|bmp|tiff?)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;

const tokenCache = { token: "", expiresAt: 0 };

const b64urlEncode = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlDecode = (t) => {
  const bin = atob(t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (t.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export function parseSource(url) {
  const m = URL_RE.exec(url.trim());
  return m ? b64urlEncode(m[0]) : null;
}

export function validateRef(ref) {
  if (!ref || !REF_RE.test(ref)) throw new HttpError(400, "Invalid ID");
}

const makeFileRef = (sharedUrl, path) => b64urlEncode(JSON.stringify({ u: sharedUrl, p: path }));
const parseFileRef = (ref) => {
  const d = JSON.parse(b64urlDecode(ref));
  return [d.u, d.p];
};

async function accessToken(env) {
  const now = Date.now() / 1000;
  if (tokenCache.token && now < tokenCache.expiresAt - 60) return tokenCache.token;
  if (env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET && env.DROPBOX_REFRESH_TOKEN) {
    const res = await fetch("https://api.dropbox.com/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: env.DROPBOX_REFRESH_TOKEN,
        client_id: env.DROPBOX_APP_KEY,
        client_secret: env.DROPBOX_APP_SECRET,
      }),
    });
    if (res.status !== 200) throw new HttpError(502, "Failed to refresh Dropbox access token");
    const data = await res.json();
    tokenCache.token = data.access_token;
    tokenCache.expiresAt = now + (data.expires_in || 14400);
    return tokenCache.token;
  }
  if (env.DROPBOX_ACCESS_TOKEN) return env.DROPBOX_ACCESS_TOKEN;
  throw new HttpError(500, "Server is missing Dropbox credentials");
}

async function dbxError(res) {
  try { return (await res.json()).error_summary || "Dropbox API request failed"; } catch { return "Dropbox API request failed"; }
}

async function apiPost(env, path, body) {
  const token = await accessToken(env);
  const res = await fetch(`https://api.dropboxapi.com/2/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new HttpError(res.status < 500 ? res.status : 502, await dbxError(res));
  return res.json();
}

// Dropbox-API-Arg is an HTTP header, so non-ASCII characters must be \u-escaped.
const apiArg = (obj) =>
  JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

async function contentFetch(env, path, arg, range) {
  const token = await accessToken(env);
  const headers = { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": apiArg(arg) };
  if (range) headers.Range = range;
  return fetch(`https://content.dropboxapi.com/2/${path}`, { method: "POST", headers });
}

// Dropbox gives "YYYY-MM-DDTHH:MM:SSZ"; match Drive's EXIF-style "YYYY:MM:DD HH:MM:SS" (what the frontend parses).
const toExifTime = (iso) => (iso ? iso.replace("-", ":").replace("-", ":").replace(/Z$/, "").replace("T", " ") : null);

export async function listGallery(env, sourceId) {
  const sharedUrl = b64urlDecode(sourceId);
  const entries = [];
  let data = await apiPost(env, "files/list_folder", {
    path: "", shared_link: { url: sharedUrl }, include_media_info: true, recursive: true,
  });
  entries.push(...(data.entries || []));
  while (data.has_more) {
    data = await apiPost(env, "files/list_folder/continue", { cursor: data.cursor });
    entries.push(...(data.entries || []));
  }

  const files = [];
  for (const entry of entries) {
    if (entry[".tag"] !== "file") continue;
    const name = entry.name || "";
    const video = VIDEO_EXT_RE.test(name);
    if (!video && !IMAGE_EXT_RE.test(name)) continue;
    const media = entry.media_info?.metadata || {};
    const dims = media.dimensions;
    files.push({
      id: makeFileRef(sharedUrl, entry.path_lower),
      name,
      createdTime: entry.client_modified,
      modifiedTime: entry.server_modified,
      mimeType: video ? "video/*" : "image/*",
      imageMediaMetadata: dims ? { width: dims.width, height: dims.height, time: toExifTime(media.time_taken) } : null,
    });
  }

  let folderName = sharedUrl.replace(/\/+$/, "").split("/").pop().split("?")[0] || "Gallery";
  try {
    const meta = await apiPost(env, "sharing/get_shared_link_metadata", { url: sharedUrl });
    folderName = meta.name || folderName;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
  }
  return { name: folderName, files };
}

async function getThumbnail(env, fileRef, size) {
  const [url, path] = parseFileRef(fileRef);
  const res = await contentFetch(env, "files/get_thumbnail_v2", { resource: { ".tag": "link", url, path }, format: "jpeg", size });
  if (res.status !== 200) throw new HttpError(res.status < 500 ? res.status : 502, await dbxError(res));
  return { bytes: await res.arrayBuffer(), contentType: res.headers.get("content-type") || "application/octet-stream" };
}

export const getThumb = (env, ref) => getThumbnail(env, ref, "w640h480");
export const getFull = (env, ref) => getThumbnail(env, ref, "w2048h1536");

export async function openDownload(env, fileRef, range = null) {
  const [url, path] = parseFileRef(fileRef);
  const res = await contentFetch(env, "sharing/get_shared_link_file", { url, path }, range);
  if (res.status !== 200 && res.status !== 206) throw new HttpError(404, "File not found or link no longer public");
  return res;
}
