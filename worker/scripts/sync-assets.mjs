// Copies the public frontend into ./public for the Worker's assets binding.
// index.html and static/ live once, in the repo root (shared with the Python
// app until cutover); ./public is generated and git-ignored. admin.html is NOT
// copied — the Worker serves it only after Basic auth.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const out = join(here, "..", "public");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "index.html"), join(out, "index.html"));
cpSync(join(root, "static"), join(out, "static"), { recursive: true });
console.log("synced assets ->", out);
