import assert from "node:assert/strict";
import { test } from "node:test";
import * as drive from "../src/providers/drive.js";
import { folderOf } from "../src/providers/dropbox.js";

const FOLDER = "application/vnd.google-apps.folder";

test("drive listGallery tags each file with its subfolder path", async () => {
  // root -> a.jpg, Alice/ -> b.jpg, Alice/Ceremony/ -> c.mp4, notes.txt (skipped)
  const tree = {
    rootfolder01: [
      { id: "file_a_0001", name: "a.jpg", mimeType: "image/jpeg" },
      { id: "alicefolder", name: "Alice", mimeType: FOLDER },
      { id: "file_txt_01", name: "notes.txt", mimeType: "text/plain" },
    ],
    alicefolder: [
      { id: "file_b_0001", name: "b.jpg", mimeType: "image/jpeg" },
      { id: "ceremony001", name: "Ceremony", mimeType: FOLDER },
    ],
    ceremony001: [{ id: "file_c_0001", name: "c.mp4", mimeType: "video/mp4" }],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/files/rootfolder01")) return Response.json({ name: "Wedding" });
    const parent = /'([^']+)' in parents/.exec(u.searchParams.get("q"))[1];
    return Response.json({ files: tree[parent] });
  };
  try {
    const { name, files } = await drive.listGallery({ DRIVE_API_KEY: "k" }, "rootfolder01");
    assert.equal(name, "Wedding");
    const byId = Object.fromEntries(files.map((f) => [f.id, f.folder]));
    assert.deepEqual(byId, { file_a_0001: [], file_b_0001: ["Alice"], file_c_0001: ["Alice", "Ceremony"] });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("dropbox folderOf uses the path relative to the shared link root", () => {
  assert.deepEqual(folderOf({ path_display: "/a.jpg" }), []);
  assert.deepEqual(folderOf({ path_display: "/Alice/Ceremony/c.jpg", path_lower: "/alice/ceremony/c.jpg" }), ["Alice", "Ceremony"]);
  assert.deepEqual(folderOf({ path_lower: "/alice/b.jpg" }), ["alice"]);
  assert.deepEqual(folderOf({}), []);
});
