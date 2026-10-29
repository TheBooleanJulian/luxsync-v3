import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, contentDisposition, dedupeNames, isVideo, normalizeEmail, requireAdmin, sanitizeZipName } from "../src/util.js";

test("normalizeEmail", () => {
  assert.equal(normalizeEmail(" Foo@Bar.COM "), "foo@bar.com");
  for (const bad of ["", "nope", "a@b", "a b@c.com", null, undefined]) assert.equal(normalizeEmail(bad), null);
});

test("contentDisposition survives non-latin-1 names (curly apostrophe regression)", () => {
  const h = contentDisposition("Julian\u2019s Shoot \u2014 caf\u00e9.zip");
  assert.match(h, /^attachment; filename="Julian_s Shoot _ caf_\.zip"; filename\*=UTF-8''Julian%E2%80%99s%20Shoot%20%E2%80%94%20caf%C3%A9\.zip$/);
  assert.ok(/^[\x20-\x7e]*$/.test(h), "header must be plain ASCII");
  assert.ok(!contentDisposition('a"b\r\nc').includes("\n"));
});

test("dedupeNames", () => {
  assert.deepEqual(dedupeNames(["a.jpg", "a.jpg", "b", "b", "a.jpg"]), ["a.jpg", "a (2).jpg", "b", "b (2)", "a (3).jpg"]);
});

test("sanitizeZipName does not double .zip", () => {
  assert.equal(sanitizeZipName("Hatsunemelvin V6 Miku MBS.zip"), "Hatsunemelvin V6 Miku MBS");
  assert.equal(sanitizeZipName('  ../a:b"c  '), "abc");
  assert.equal(sanitizeZipName(""), "gallery");
});

test("isVideo", () => {
  assert.ok(isVideo("clip.MOV"));
  assert.ok(!isVideo("a.jpg"));
});

const basic = (u, p) => new Request("https://x/admin", { headers: { Authorization: "Basic " + btoa(`${u}:${p}`) } });
const status = async (fn) => { try { await fn(); return 200; } catch (e) { assert.ok(e instanceof HttpError); return e.status; } };

test("admin auth: disabled without password, password required, username enforced when set", async () => {
  assert.equal(await status(() => requireAdmin(basic("a", "b"), {})), 404);
  const env = { ADMIN_PASSWORD: "secret" };
  assert.equal(await status(() => requireAdmin(new Request("https://x/admin"), env)), 401);
  assert.equal(await status(() => requireAdmin(basic("any", "wrong"), env)), 401);
  assert.equal(await status(() => requireAdmin(basic("any", "secret"), env)), 200);
  const named = { ADMIN_PASSWORD: "secret", ADMIN_USERNAME: "julian" };
  assert.equal(await status(() => requireAdmin(basic("other", "secret"), named)), 401);
  assert.equal(await status(() => requireAdmin(basic("julian", "wrong"), named)), 401);
  assert.equal(await status(() => requireAdmin(basic("julian", "secret"), named)), 200);
  assert.equal(await status(() => requireAdmin(basic("julian", "se:cret"), { ...named, ADMIN_PASSWORD: "se:cret" })), 200);
});
