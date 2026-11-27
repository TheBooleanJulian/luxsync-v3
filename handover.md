# Handover: luxsync-v3

_Last updated: 2026-11-27_

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

### 3. Turn on owner sign-in to Drive (the root fix for Google's cap)

Built in v0.18.0 and waiting for your sign-in. Google caps *anonymous* downloads of a popular file (`LS-DRV-FILE`), and the Worker currently downloads anonymously with an API key. With your read-only sign-in it downloads as the folders' owner instead. If the sign-in ever fails, it quietly falls back to the API key.

- [ ] **Google Cloud console**, in the project that owns `DRIVE_API_KEY`:
  - [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent): user type **Internal**, so the sign-in doesn't expire after 7 days; scope `.../auth/drive.readonly`.
  - [Credentials](https://console.cloud.google.com/apis/credentials) → *Create credentials* → *OAuth client ID* → **Desktop app**. Download the JSON and save it as [`secrets/google-oauth-client.json`](secrets/google-oauth-client.json).
- [ ] **Sign in** from the repo root as `juliancheung@accurova.com`. It writes `secrets/luxsync-google-oauth.json`:
  ```
  python tools/google_oauth.py
  ```
- [ ] **Load it into the Worker**, from `worker/`:
  ```
  npx wrangler secret bulk ../secrets/luxsync-google-oauth.json
  ```
- [ ] **Check** [`/admin#health`](https://luxsync-v3.accurova.com/admin#health) → *Setup* shows owner sign-in **On**, then tell Claude. Claude will confirm on a capped file that it really downloads.

### 4. Turn on Telegram alerts

Built in v0.18.0 and off until these are set. You get a message when a client is shown an error (once per gallery per 30 min), when Google starts capping (once per 6 h), or when the Worker crashes (once per hour). It only sends, so a bot that polls elsewhere is unaffected.

- [ ] Pick the bot (any fleet bot, or a new one from [@BotFather](https://t.me/BotFather)) and **send it any message** so it may message you.
- [ ] Get your chat ID from [@userinfobot](https://t.me/userinfobot).
- [ ] From `worker/`, set both (each command prompts for the value, so it never lands in your shell history):
  ```
  npx wrangler secret put TELEGRAM_BOT_TOKEN
  npx wrangler secret put TELEGRAM_CHAT_ID
  ```
- [ ] [`/admin#health`](https://luxsync-v3.accurova.com/admin#health) → *Setup* → **Send test alert**.

### 5. Watch your deliverables folder (mirror at delivery)

- [ ] In [`/admin#mirror`](https://luxsync-v3.accurova.com/admin#mirror) → *Mirror new galleries automatically*, paste the link of `#CLIENT_DELIVERABLES/2026` (and the 2027 one in January). New gallery folders in it are then copied within ~20 minutes, before you send the link. Do this after step 3: reading a private folder needs the owner sign-in.

## Current state

- **v0.18.0** on `main`, deployed by Workers Builds, served at `luxsync-v3.thebooleanjulian.dev` and `luxsync-v3.accurova.com`.
- **Debugging:** [`/admin#errors`](https://luxsync-v3.accurova.com/admin#errors) is the error console: every server error and every error report a client was shown. Paste a client's `Ref` into its search. [`/admin#health`](https://luxsync-v3.accurova.com/admin#health) shows what's failing now. The Worker serves previews, downloads and zips from the R2 mirror ([`worker/src/mirror.js`](worker/src/mirror.js)) and falls back to Drive.
- The mirror copies every opened gallery via a cron job every 5 min. Originals expire 30 days after the last open; thumbnails and previews never do. Galleries and their status are listed on [`/admin`](https://luxsync-v3.thebooleanjulian.dev/admin).

## What changed (2026-11-20)

- **v0.15.2:** a video that can't be opened is skipped and listed in `_MISSING_FILES.txt` instead of ending the zip. Before this fix, a client got "0 of 8 files" because of one blocked video.
- **v0.16.0:** [`tools/r2_push.py`](tools/r2_push.py) uploads originals to R2 from the local Drive for Desktop copy, for files Google's cap blocks. `cf`/`wrangler` uploads stop at 300 MB; this script has no limit.
- **GLS Bedok:** 6 of 8 videos uploaded to R2 by hand.
- **2026-11-23, v0.16.1:** second domain `luxsync-v3.accurova.com`.
- **2026-11-23, v0.16.2:** the mirror copies never-copied galleries first, parks a gallery for 3 h after 3 cap errors in a row, and starts each pass at a random file.
- **2026-11-23, Fatui National Gallery:** all 271 originals uploaded to R2 from K: after a client's photo hit the cap.
- **2026-11-24, v0.17.0:** `/admin` dashboard (Health / Errors / Mirror / Downloads) with an error console, including the error reports clients see.
- **2026-11-27, v0.18.0:**
  - Files Google can't preview no longer block the mirror or flood the log.
  - Clients' error box links to the original Drive folder when LuxSync itself failed, or says to wait a few hours for Google's cap.
  - Watched folders (mirror at delivery).
  - Owner sign-in and Telegram alerts (steps 3 and 4).
  - Tests in GitHub Actions.
  - Workers Logs on.

## Open questions / not done

- Google's cap also counts direct Drive downloads of the shared folder. The more a gallery's Drive link circulates, the sooner its files hit the cap. Sharing only the LuxSync link avoids that.
- `claude-debug@example.com` test rows remain in the D1 `downloads` log.
- The admin *Prepare gallery* UI hasn't been tested end-to-end by Claude (no admin password). Expiry hasn't run on real data yet; the earliest is ~2026-12-19.
