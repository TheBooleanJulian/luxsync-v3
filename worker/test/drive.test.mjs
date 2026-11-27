import assert from "node:assert/strict";
import { test } from "node:test";
import { getThumb } from "../src/providers/drive.js";

test("Drive images come from the lh3 CDN, falling back to drive.google.com/thumbnail", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(new URL(url).host);
    if (new URL(url).host === "lh3.googleusercontent.com") return new Response("<html>", { status: 500, headers: { "content-type": "text/html" } });
    return new Response(new Uint8Array([0xff, 0xd8]), { headers: { "content-type": "image/jpeg" } });
  });
  const { contentType } = await getThumb({}, "abc1234567");
  assert.equal(contentType, "image/jpeg");
  assert.deepEqual(seen, ["lh3.googleusercontent.com", "drive.google.com"]);
});

test("many concurrent thumbnail requests don't queue behind each other", async (t) => {
  // Regression: a shared 10-slot semaphore leaked slots from cancelled requests (error 1101).
  let inFlight = 0, peak = 0;
  t.mock.method(globalThis, "fetch", async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
  });
  await Promise.all(Array.from({ length: 30 }, (_, i) => getThumb({}, `ref000000${i}`)));
  assert.equal(peak, 30);
});

// ---------- owner sign-in ----------
// The access token is cached per module, so these run in order and the
// refresh-failure case comes last.
import { openDownload } from "../src/providers/drive.js";
import { errorQueue } from "../src/util.js";

const OWNER = { DRIVE_API_KEY: "pubkey", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", GOOGLE_REFRESH_TOKEN: "rtok", DRIVE_MIN_INTERVAL_MS: "0" };
const tokenOk = () => Response.json({ access_token: "atok", expires_in: 3600 });
const driveError = (status, reason) => Response.json({ error: { errors: [{ reason }] } }, { status });

test("with owner sign-in, downloads use the owner's token, not the API key", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return tokenOk();
    return new Response("bytes", { status: 200 });
  });
  const res = await openDownload(OWNER, "file1234567");
  assert.equal(res.status, 200);
  const dl = calls.find((c) => c.url.includes("/files/file1234567"));
  assert.equal(dl.auth, "Bearer atok");
  assert.doesNotMatch(dl.url, /key=/);
});

test("a file the owner account can't see is retried once with the API key", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    urls.push(String(url));
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return tokenOk();
    return init.headers?.Authorization ? driveError(404, "notFound") : new Response("bytes", { status: 200 });
  });
  const res = await openDownload(OWNER, "file1234567");
  assert.equal(res.status, 200);
  assert.match(urls.at(-1), /key=pubkey/);
});

test("Google's cap on an owner download is still LS-DRV-FILE (no pointless retry)", async (t) => {
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return tokenOk();
    downloads++;
    return driveError(403, "downloadQuotaExceeded");
  });
  await assert.rejects(openDownload(OWNER, "file1234567"), (e) => e.detail?.code === "LS-DRV-FILE");
  assert.equal(downloads, 1);
});

test("if the owner token can't be refreshed, downloads fall back to the API key", async (t) => {
  errorQueue.length = 0;
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    urls.push(String(url));
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return Response.json({ error: "invalid_grant" }, { status: 400 });
    // The cached token was revoked: Google answers 401, the refresh fails too.
    return init.headers?.Authorization ? new Response("", { status: 401 }) : new Response("bytes", { status: 200 });
  });
  const res = await openDownload(OWNER, "file7654321");
  assert.equal(res.status, 200);
  assert.match(urls.at(-1), /key=pubkey/);
  assert.ok(errorQueue.some((e) => e.code === "LS-DRV-AUTH"), "the failed sign-in is logged for /admin");

  // For the next few minutes the owner path is skipped entirely: no token calls.
  urls.length = 0;
  await openDownload(OWNER, "file7654321");
  assert.equal(urls.filter((u) => u.includes("oauth2")).length, 0);
});
