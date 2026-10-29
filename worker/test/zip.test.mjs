import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, generatorToStream, zipStream } from "../src/zip.js";

async function collect(gen) {
  const parts = [];
  for await (const c of gen) parts.push(c);
  return Buffer.concat(parts);
}

const pyCheck = (file) =>
  JSON.parse(execFileSync("python", ["-c", `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "files": {i.filename: z.read(i).hex() for i in z.infolist()}}))
`, file]).toString());

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("zip: buffered photos, a streamed video and unicode names read back intact", async () => {
  const photo = Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 251));
  const video = Buffer.from(Array.from({ length: 200000 }, (_, i) => (i * 7) % 256));
  async function* videoChunks() { for (let o = 0; o < video.length; o += 65536) yield new Uint8Array(video.subarray(o, o + 65536)); }
  async function* entries() {
    yield { name: "a.jpg", data: new Uint8Array(photo) };
    yield { name: "Julian\u2019s caf\u00e9.mp4", data: videoChunks(), size: video.length };
    yield { name: "_MISSING_FILES.txt", data: new TextEncoder().encode("x\n") };
  }
  const zip = await collect(zipStream(entries()));
  const dir = mkdtempSync(join(tmpdir(), "luxzip-"));
  const file = join(dir, "t.zip");
  writeFileSync(file, zip);
  const out = pyCheck(file);
  assert.equal(out.bad, null);
  assert.equal(out.files["a.jpg"], photo.toString("hex"));
  assert.equal(out.files["Julian\u2019s caf\u00e9.mp4"], video.toString("hex"));
  assert.equal(out.files["_MISSING_FILES.txt"], Buffer.from("x\n").toString("hex"));
});

test("zip: empty archive is valid", async () => {
  async function* none() {}
  const dir = mkdtempSync(join(tmpdir(), "luxzip-"));
  const file = join(dir, "e.zip");
  writeFileSync(file, await collect(zipStream(none())));
  assert.deepEqual(pyCheck(file).files, {});
});

test("generatorToStream propagates data and errors", async () => {
  async function* ok() { yield new Uint8Array([1, 2]); yield new Uint8Array([3]); }
  const bytes = Buffer.from(await new Response(generatorToStream(ok())).arrayBuffer());
  assert.deepEqual([...bytes], [1, 2, 3]);
  async function* bad() { yield new Uint8Array([1]); throw new Error("boom"); }
  await assert.rejects(new Response(generatorToStream(bad())).arrayBuffer(), /boom/);
});
