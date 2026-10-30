# LuxSync v3 — project-specific

## Dependencies (exception to stdlib-first)
This is a photo-gallery proxy/cache product — its core function genuinely
needs: `boto3` (S3-compatible storage for permanent image cache, Backblaze
B2/Cloudflare R2), `slowapi` (per-IP rate limiting), `httpx`, `stream-zip`
(zero-buffer zip streaming). These are justified by the product, not a
stdlib-first violation to flag.

## Deploy
Procfile-based (not Dockerfile) for Zeabur — matches this repo's existing
convention, don't switch without reason.

## Database
SQLite for download-tracking log (`/admin` dashboard) — matches the global default, no exception here.

## Versioning
Uses semver with a version badge in README (currently 0.9.0) — this repo
has adopted a version-tagging convention your global AGENTS.md leaves open.
Keep bumping it; don't silently drop the practice.

## Multi-provider architecture
Every gallery source lives in `providers/`, implementing a 5-function
interface (`parse_source`, `validate_ref`, `list_gallery`, `get_thumb`/
`get_full`, `stream_download`) documented in `providers/__init__.py`.
`main.py` has no source-specific logic. See README's "Adding a provider"
section before touching gallery-source code.

## Security-sensitive area
`/admin` is password-gated (`ADMIN_USERNAME`/password). Treat changes here
as auth-adjacent — flag before altering, per the global "needs explicit
approval" list.

## Worker secrets (Cloudflare)
Production runs as the `luxsync-v3` Cloudflare Worker (`worker/`). Its secrets
(`DRIVE_API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `IP_HASH_SALT`) live only
in Cloudflare, and are NOT in `wrangler.jsonc` or this repo. The master copy is
`secrets/luxsync-worker-admin.txt` in this repo (git-ignored via `secrets/`)
(not in git; agents are denied read access, so never print or paste its values).

- Any deploy that replaces the Worker script (an assets-only upload, a deploy
  from another folder, a rename) wipes them, and the symptoms are: `/api/*`
  returns "Server is missing DRIVE_API_KEY" (or empty 404s), and `/admin` returns 404.
- Restore, run by Julian from `worker/`:
  `npx wrangler secret bulk ../secrets/luxsync-worker-admin.txt`
- Always deploy with `cd worker && npm run deploy -- --keep-vars` so dashboard
  variables survive. Never deploy this Worker name from any other folder.
- After a redeploy or restore, check: gallery loads, one download works, `/admin` asks for a login.
