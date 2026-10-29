// Turns the JSON exported from the Python app's /admin (gallery.json + photo.json,
// from /api/admin/downloads?view=...&limit=500) into import.sql for D1.
//   node scripts/import-log.mjs <dir-with-gallery.json-and-photo.json>
//   npx wrangler d1 execute luxsync-log --remote --file=<dir>/import.sql
// Original row ids are kept and INSERT OR IGNORE makes it safe to re-run.
// The API never exposes ip_hash, so imported rows carry the placeholder "imported".
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/import-log.mjs <export-dir>"); process.exit(1); }

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const rows = [];
let expected = 0;
for (const view of ["gallery", "photo"]) {
  const data = JSON.parse(readFileSync(join(dir, `${view}.json`), "utf8"));
  if (data.items.length !== data.total) throw new Error(`${view}.json is incomplete (${data.items.length}/${data.total}); re-export with a higher limit`);
  expected += data.total;
  rows.push(...data.items);
}
rows.sort((a, b) => a.id - b.id);

const sql = rows.map((r) =>
  "INSERT OR IGNORE INTO downloads (id, ts, email, optin, provider, source, gallery_name, kind, file_count, filenames, ip_hash) VALUES (" +
  [r.id, q(r.ts), q(r.email), r.optin ? 1 : 0, q(r.provider), q(r.source), q(r.gallery_name), q(r.kind), r.file_count, q(JSON.stringify(r.filenames)), q("imported")].join(", ") + ");",
);
writeFileSync(join(dir, "import.sql"), sql.join("\n") + "\n");
console.log(`wrote import.sql (next to the input) with ${rows.length} rows (expected ${expected})`);
