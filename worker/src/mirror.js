// R2 mirror of gallery files. "Prepare gallery" in /admin copies every file's
// thumbnail, full-size preview and original bytes into R2 once, at a pace the
// source tolerates; visitors are then served from R2 and never wait on (or use
// up) Google Drive's burst throttling and per-file download limits. Files that
// were never prepared still fall back to the source, as before.
import { HttpError, LuxError, describe, guessType } from "./util.js";

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

/** POST /api/admin/prepare {provider, id, name, video}. Streams NDJSON:
 * {"bytes":n,"total":n} progress lines (so a multi-GB copy keeps the connection
 * alive), then {"done":true,"parts":{...}}. */
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
    .then((parts) => send({ done: true, parts }))
    .catch((err) => send({ done: true, error: err instanceof HttpError ? err.detail : String(err) }))
    .finally(() => writer.close().catch(() => {}));
  ctx.waitUntil(work);
  return new Response(readable, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
