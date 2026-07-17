# LuxSync v3

A premium photo gallery that turns any public Google Drive folder into a scrollable,
previewable, downloadable client gallery. FastAPI backend + a single self-contained
HTML frontend — no database, no build step.

## How it works

Client pastes a Drive folder link into the setup screen. The **browser never talks to
Google directly** — it calls this app's own backend, which holds the Drive API key and
does the real work:

- `GET /api/gallery/{folderId}` — calls Drive's `files.get` + `files.list` with the
  server-side key, and caches the result (folder name + file list) in object storage for
  `FOLDER_CACHE_TTL_SECONDS` (default 10 minutes). This is the only place the API key is
  ever used, so a cache hit costs zero Drive API quota.
- `GET /api/thumb/{fileId}` / `GET /api/full/{fileId}` — fetch the image from Drive's
  public (keyless) thumbnail endpoint once, cache the bytes in object storage
  permanently, and serve from cache after that.
- `GET /api/download/{fileId}` — streams the original file through this server instead of
  linking straight to `drive.google.com`, so downloads are rate-limited the same as
  everything else.
- `POST /api/download-zip` — select multiple photos in the grid (the small circle in the
  corner of each frame) and click **Download Selected**: with 2+ selected, this endpoint
  streams a zip built on the fly with [stream-zip](https://pypi.org/project/stream-zip/),
  piping each file straight from Drive into the zip into the HTTP response — nothing is
  buffered in memory or on disk, so a 500-photo zip costs the same RAM as a 5-photo one.
  With exactly one selected, it just downloads that file directly instead of a 1-item zip.

Every route above is IP-rate-limited independently, so one visitor hammering refresh
degrades gracefully instead of burning through Drive's quota for everyone.

### Serving cached images via Cloudflare instead of through this server

If `CDN_BASE_URL` is set, `/api/thumb` and `/api/full` skip proxying bytes for anything
already cached — they just `302` the browser straight to the CDN. Point that at a
Cloudflare-proxied CNAME in front of your B2/R2 bucket and:

- B2 egress is free when traffic actually routes through Cloudflare's proxy (the
  [Bandwidth Alliance](https://www.cloudflare.com/bandwidth-alliance/)) — a DNS-only
  (grey cloud) record does **not** qualify, it has to be proxied (orange cloud).
- This server's own bandwidth/CPU drops to near zero for repeat image requests, since it's
  no longer in the data path at all for cache hits.

**Setting it up (Backblaze B2 + Cloudflare):**
1. [backblaze.com](https://www.backblaze.com/) → B2 Cloud Storage → create a bucket
   (e.g. `luxsync-cache`), **Files in Bucket: Public** (these are just cached copies of
   photos already shared publicly via the Drive link).
2. Note the bucket's **Endpoint** (e.g. `s3.us-west-004.backblazeb2.com`) and **Friendly
   URL** host (e.g. `f004.backblazeb2.com`) from the bucket's details page.
3. **App Keys → Add a New Application Key**, restricted to that bucket, Read+Write — this
   gives you `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`.
4. In Cloudflare (your domain must already be on Cloudflare): **DNS → Add record** — type
   `CNAME`, name e.g. `cdn`, target = the bucket's Friendly URL host, **Proxy status:
   Proxied** (this is the part that actually triggers free egress).
5. **SSL/TLS → Overview** → encryption mode **Full**.
6. `CDN_BASE_URL` = `https://cdn.yourdomain.com/file/luxsync-cache` (native B2 URL shape:
   `/file/<bucket>/<key>` — the code just appends the cache key).

Without `CDN_BASE_URL` set, thumbnails/full images still get cached in B2/R2 exactly as
before, just proxied through this server on every request instead of redirected.

## Requirements

- The Drive folder must be shared as **Anyone with the link — Viewer**.
- A **Google Drive API key** (Drive API v3 enabled), set server-side only (see below).
- An **S3-compatible object storage bucket** for caching — [Cloudflare R2](https://developers.cloudflare.com/r2/)
  or [Backblaze B2](https://www.backblaze.com/cloud-storage) both work as-is, since the
  backend talks to them over the S3 API. R2 has free egress; B2 has a 10GB free tier.
  Optional: if you don't set a bucket, the app still runs, it just re-hits Drive on every
  request instead of caching.

### Getting a Drive API key
1. [console.cloud.google.com](https://console.cloud.google.com/) → create/select a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → Credentials → Create Credentials → API key**.
4. Restrict the key to the Drive API. You do **not** need to restrict it by HTTP referrer
   this time — it never leaves the server, so there's no browser origin to restrict it to.

### Getting an object storage bucket
- **Cloudflare R2**: dashboard → R2 → Create bucket → create an S3 API token (Account →
  R2 → Manage API Tokens) for `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`. Endpoint is
  `https://<account-id>.r2.cloudflarestorage.com`.
- **Backblaze B2**: create a bucket, then an "Application Key" restricted to it for the
  same two values. Endpoint looks like `https://s3.<region>.backblazeb2.com`.
- Optional: set a lifecycle rule on the bucket (in the provider's console) to expire
  objects after N days if you don't want to keep cached thumbnails forever.

## Environment variables

| Variable                  | Required | Purpose                                             |
|----------------------------|----------|------------------------------------------------------|
| `DRIVE_API_KEY`            | yes      | Server-side Google Drive API key                     |
| `S3_ENDPOINT_URL`          | no       | R2/B2 S3-compatible endpoint                          |
| `S3_BUCKET`                | no       | Bucket name for cached folder listings/thumbnails     |
| `S3_ACCESS_KEY_ID`         | no       | S3 access key                                         |
| `S3_SECRET_ACCESS_KEY`     | no       | S3 secret key                                         |
| `S3_REGION`                | no       | Defaults to `auto` (fine for R2)                      |
| `FOLDER_CACHE_TTL_SECONDS` | no       | Folder listing cache lifetime, default `600`          |
| `CDN_BASE_URL`             | no       | Cloudflare-fronted B2/R2 base URL for free-egress image serving (see below) |

## Local dev

```bash
python3 -m venv .venv
source .venv/bin/activate   # .venv\Scripts\activate on Windows
pip install -r requirements.txt
export DRIVE_API_KEY=your-key-here   # $env:DRIVE_API_KEY on PowerShell
uvicorn main:app --reload --port 8080
# open http://localhost:8080
```

Object storage env vars are optional locally — without them, `/api/gallery`,
`/api/thumb`, and `/api/full` just skip the cache and hit Drive every time.

## Deploy — GitHub → Zeabur

1. Push changes to [TheBooleanJulian/luxsync-v3](https://github.com/TheBooleanJulian/luxsync-v3):
   ```bash
   git add .
   git commit -m "..."
   git push origin main
   ```
2. In [Zeabur](https://zeabur.com): **New Project → Deploy from GitHub** → select this
   repo. Zeabur detects `requirements.txt` + [Procfile](Procfile) and runs
   `uvicorn main:app --host 0.0.0.0 --port $PORT`.
3. In the service's **Variables** tab, set `DRIVE_API_KEY` and the `S3_*` variables from
   the table above, then redeploy.
4. Add a custom domain under the service's **Domains** tab if you want a branded link
   (e.g. `gallery.luxsync.app`) to hand to clients.

### Branch strategy (optional, matches the usual fleet pattern)

```
feature/* → dev → main
```
Point Zeabur's production service at `main`; spin up a second Zeabur service tracking
`dev` for a staging preview if you want to test layout changes before clients see them.

## Sharing a gallery

The header's **Share** button copies a link like `https://yourdomain/?folder=<id>&sort=date-asc`.
Opening that link pre-fills the folder field and auto-loads the gallery — no key or setup
step for the recipient, since the key lives on the server now.

## Known limitations (v3)

- **"Download All" (as opposed to "Download Selected") is still sequential, not zipped.**
  Selecting photos individually and using **Download Selected** gets you the streamed zip;
  "Download All" just triggers every download one after another.
- **Zips are capped at `MAX_ZIP_FILES` (200)** per request to keep one request from tying
  up a Drive-fetching connection pool indefinitely.
- **Folder cache TTL is time-based, not push-based.** If a client adds/removes photos from
  the Drive folder, changes show up after the cache entry expires (`FOLDER_CACHE_TTL_SECONDS`),
  not instantly. Lower the TTL if you need faster turnaround, at the cost of more Drive calls.

## Roadmap

- Give each client a slug/subdomain with custom branding.
- Add basic auth or an access-code gate per gallery.
- Make "Download All" just select everything and reuse the zip path instead of firing N
  sequential single-file downloads.
