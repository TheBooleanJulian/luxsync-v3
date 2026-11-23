# Handover: luxsync-v3

_Last updated: 2026-11-23_

## Your next steps

Tick these off as you go (`[ ]` → `[x]`).

### 1. Get the last two GLS Bedok videos into R2 (client waiting)

Google's per-file download cap (`LS-DRV-FILE`) blocks *Day 1 – AM_pile* (353 MiB) and *Day 2 – AM_pile* (381 MiB) for clients and for the mirror. The other 6 are already in R2.

- [ ] **Create an R2 key:** [Cloudflare → R2 → Manage API tokens](https://dash.cloudflare.com/c580c4403524273d1bece674117472dd/r2/api-tokens) → *Create API token*:
  - Permissions: **Object Read & Write**
  - Bucket: **Apply to specific buckets only** → `luxsync-cache`
  - TTL: Forever
- [ ] **Save it** to [`secrets/r2-s3.env`](secrets/r2-s3.env) (create the file; `secrets/` is git-ignored and Claude can't read it):
  ```
  R2_ACCOUNT_ID=c580c4403524273d1bece674117472dd
  R2_ACCESS_KEY_ID=<Access Key ID>
  R2_SECRET_ACCESS_KEY=<Secret Access Key>
  ```
- [ ] **Upload:** tell Claude "R2 key saved", or run it yourself from this folder:
  ```
  python tools/r2_push.py "K:/My Drive/#CLIENT_DELIVERABLES/2026/2026_11_09-10 GLS Bedok" 1cTl0o66udyoYFYr1NkHbZua1ungBIgC8
  ```
  It skips the 6 already uploaded. See [`tools/r2_push.py`](tools/r2_push.py).
- [ ] **Check:** open the [GLS Bedok gallery](https://luxsync-v3.thebooleanjulian.dev/?provider=drive&source=1cTl0o66udyoYFYr1NkHbZua1ungBIgC8) and download *Day 1 – AM_pile*.
- [ ] **Tell the client** to run *Download All* again.

### 2. Decide what to do about the failing dev build check

Every dev → main PR shows **Workers Builds: luxsync-v3 — fail**. That's not the code. The `dev` build trigger is set up differently from `main`:

| Trigger | Root directory | Command | Result |
|---|---|---|---|
| `main` | `worker` | `npx wrangler deploy` | ✅ deploys |
| `dev` | `/` (repo root) | `npx wrangler preview` | ❌ runs against the root [`wrangler.jsonc`](wrangler.jsonc) guard, which has no `previews` block |

- [ ] **Pick one**, then tell Claude which. It's a deployment-config change, so it needs your go-ahead.
  - **(a) Make it a real check:** set the dev trigger's root to `worker` and its command to `npx wrangler versions upload`. Each dev push then uploads a preview version without deploying it. Watch out: a new version inherits secrets from the latest *uploaded* one, which is fine while dev builds from `worker/`.
  - **(b) Delete the dev trigger:** PRs show no Cloudflare check; the `main` build stays the real gate.
  - Where: [Workers → luxsync-v3 → Settings → Builds](https://dash.cloudflare.com/c580c4403524273d1bece674117472dd/workers/services/view/luxsync-v3/production/settings)

### 3. Decide on the long-term fix for Google's download cap

Since 2026-11-22, Google's per-file cap (`LS-DRV-FILE`) has hit most files in ~25 old BNI galleries and a new photo gallery (Fatui). The Worker downloads from Drive *anonymously* with an API key, and that's what Google caps. Your own Drive for Desktop reads the same files fine. As of v0.16.2 the mirror backs off capped galleries instead of starving new ones, but files only reach R2 when Google lets them through or when they're pushed from this PC.

- [ ] **Pick one**, then tell Claude. Option (a) is security-sensitive, so Claude won't build it without your go-ahead.
  - **(a) Owner sign-in for the Worker (recommended):** the Worker downloads as `juliancheung@accurova.com` using a read-only Google sign-in (`drive.readonly`). Needs an OAuth client in the Google Cloud project that owns `DRIVE_API_KEY`, one sign-in by you, and a refresh token stored as a Worker secret. First check: confirm on one capped file that an owner download goes through.
  - **(b) Push from this PC at delivery:** run [`tools/r2_push.py`](tools/r2_push.py) on every gallery right after delivery (needs the R2 key from step 1). No new credentials in the Worker, but a manual step per gallery.
  - **(c) Keep as is:** the mirror retries capped galleries every 3 hours, and Claude pushes urgent files from K: by hand.

## Current state

- **v0.16.2** on `main`, deployed by Workers Builds, served at `luxsync-v3.thebooleanjulian.dev` and `luxsync-v3.accurova.com`. The Worker serves previews, downloads and zips from the R2 mirror ([`worker/src/mirror.js`](worker/src/mirror.js)) and falls back to Drive.
- The mirror copies every opened gallery via a cron job every 5 min. Originals expire 30 days after the last open; thumbnails and previews never do. Galleries and their status are listed on [`/admin`](https://luxsync-v3.thebooleanjulian.dev/admin).

## What changed (2026-11-20)

- **v0.15.2:** a video that can't be opened is skipped and listed in `_MISSING_FILES.txt` instead of ending the zip. Before this fix, a client got "0 of 8 files" because of one blocked video.
- **v0.16.0:** [`tools/r2_push.py`](tools/r2_push.py) uploads originals to R2 from the local Drive for Desktop copy, for files Google's cap blocks. `cf`/`wrangler` uploads stop at 300 MB; this script has no limit.
- **GLS Bedok:** 6 of 8 videos uploaded to R2 by hand.
- **2026-11-23, v0.16.1:** second domain `luxsync-v3.accurova.com`.
- **2026-11-23, v0.16.2:** the mirror copies never-copied galleries first, parks a gallery for 3 h after 3 cap errors in a row, and starts each pass at a random file.
- **2026-11-23, Fatui National Gallery:** all 271 originals uploaded to R2 from K: after a client's photo hit the cap.

## Open questions / not done

- Google's cap also counts direct Drive downloads of the shared folder. The more a gallery's Drive link circulates, the sooner its files hit the cap. Sharing only the LuxSync link avoids that.
- `claude-debug@example.com` test rows remain in the D1 `downloads` log.
- The admin *Prepare gallery* UI hasn't been tested end-to-end by Claude (no admin password). Expiry hasn't run on real data yet; the earliest is ~2026-12-19.
