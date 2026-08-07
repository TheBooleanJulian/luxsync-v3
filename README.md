<div align="center">

![LuxSync](assets/luxsync%20banner.png)

# LuxSync v3

**A premium, dependency-free photo gallery that turns any public Google Drive or Dropbox folder into a scrollable, previewable, downloadable client gallery.**

![Version](https://img.shields.io/badge/version-0.7.0-00D4C8)
![Python](https://img.shields.io/badge/-Python-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/-FastAPI-009688?logo=fastapi&logoColor=white)
![Zeabur](https://img.shields.io/badge/-Zeabur-6C5CE7)
![License](https://img.shields.io/badge/license-AGPLv3%20%2B%20Commercial-00D4C8.svg)

</div>

---

## What it does

LuxSync v3 lets photographers hand a client a single link — the client pastes their shared Google Drive or Dropbox folder URL into the gallery, and immediately gets a fully styled, scrollable masonry grid with lightbox preview, sort controls, multi-select, and bulk zip download. Every source's API credentials live server-side only; the browser never talks to Drive or Dropbox directly. Thumbnails and full images are cached permanently in S3-compatible object storage (Backblaze B2 or Cloudflare R2), and when a Cloudflare-proxied CDN URL is configured, repeat image requests bypass the server entirely — egress from B2 is free under the Bandwidth Alliance.

## Features

- **Multi-provider gallery sources** — paste a public Google Drive folder or Dropbox shared-folder link; the backend detects which one and dispatches to the matching provider (see [Adding a provider](#adding-a-provider) to add more)
- **Server-side API credentials** — the browser calls FastAPI endpoints; Drive/Dropbox credentials never reach the client
- **Folder metadata + file list caching** — source API quota is spent once per folder per TTL window (default 10 min), cache hits cost zero quota
- **Permanent image cache in S3-compatible storage** — thumbnails and full images are fetched from the source once and stored; every subsequent request hits the cache
- **Optional Cloudflare CDN redirect** — when `CDN_BASE_URL` is set, cache-hit responses are `302`s straight to the CDN instead of proxied bytes, dropping server bandwidth to near zero
- **True masonry layout** — photos fill rows without dead space; sorts left-to-right by row; toggle between 3 and 5 columns
- **Sort dropdown** — reorder the gallery on the fly
- **Lightbox preview** — click any photo for a full-size overlay with filename and EXIF (dimensions, camera, focal length, aperture, shutter speed, ISO where the source provides it)
- **Multi-select zip download** — click to select individual photos, or select one and Shift-click another to select the whole range in between; stream a zip built on the fly via `stream-zip`, named after the gallery, with nothing buffered in memory or on disk
- **Download All** — zips the entire gallery the same way, chunked automatically for very large folders
- **Single-file download** — selecting exactly one photo skips the zip and streams the original directly
- **Per-IP rate limiting** — every route is independently limited via `slowapi`; one heavy visitor degrades gracefully without burning API quota for everyone
- **Shareable gallery links** — provider + source id encoded in the URL so a gallery view is directly linkable (old Drive-only `?folder=` links still work)
- **Zero database, no build step** — FastAPI backend + a single self-contained `index.html`

## Tech Stack

| Layer | Choice |
|---|---|
| Backend | FastAPI + httpx + slowapi |
| Gallery sources | `providers/` — Google Drive (API key) and Dropbox (OAuth2 app token), talked to directly over HTTP |
| Frontend | Single-file HTML (`index.html`) |
| Image cache | S3-compatible object storage (Backblaze B2 / Cloudflare R2) via boto3 |
| Zip streaming | stream-zip |
| Hosting | Zeabur (Procfile, GitHub CI/CD, feature → dev → main) |

## Quick Start

```bash
git clone https://github.com/TheBooleanJulian/luxsync-v3
cd luxsync-v3
pip install -r requirements.txt
cp .env.example .env   # fill in required values
python main.py
```

> Drive folders must be shared as **Anyone with the link — Viewer**. Dropbox is optional — see [Dropbox setup](#dropbox-setup) below.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `DRIVE_API_KEY` | ✅ | Google Drive API v3 key (never sent to the browser) |
| `DROPBOX_APP_KEY` | ❌ | Dropbox app key — only needed to support Dropbox links, see [Dropbox setup](#dropbox-setup) |
| `DROPBOX_APP_SECRET` | ❌ | Dropbox app secret |
| `DROPBOX_REFRESH_TOKEN` | ❌ | Long-lived Dropbox refresh token; the server mints its own short-lived access token from this automatically |
| `DROPBOX_ACCESS_TOKEN` | ❌ | Alternative to the three vars above for quick local testing — a token pasted straight from the app console (expires after a few hours) |
| `S3_ACCESS_KEY_ID` | ✅ | Access key for your B2 / R2 bucket |
| `S3_SECRET_ACCESS_KEY` | ✅ | Secret key for your B2 / R2 bucket |
| `S3_ENDPOINT_URL` | ✅ | S3-compatible endpoint URL (e.g. `https://s3.us-west-004.backblazeb2.com`) |
| `S3_BUCKET` | ✅ | Bucket name for image cache (e.g. `luxsync-cache`) |
| `S3_REGION` | ❌ | Region passed to the S3 client (default `auto`) |
| `CDN_BASE_URL` | ❌ | Cloudflare-proxied base URL for cached images (e.g. `https://cdn.yourdomain.com/file/luxsync-cache`). When set, cache-hit image requests are redirected to the CDN instead of proxied. |
| `FOLDER_CACHE_TTL_SECONDS` | ❌ | How long to cache folder listings (default `600`) |

### Dropbox setup

Dropbox galleries work the same way Drive ones do — visitors never authenticate. The server holds one app-owned token that can read any public shared-folder link.

1. Create an app at [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) — "Scoped access", "App folder" or "Full Dropbox" (either works, since access is always via the shared link, not your own files).
2. Under **Permissions**, enable `sharing.read` and `files.metadata.read`, then re-generate the access token.
3. Run through the OAuth2 authorization-code flow with `token_access_type=offline` to get a **refresh token** for the app (the standard flow every Dropbox SDK's `DropboxOAuth2FlowNoRedirect` helper walks you through) — this is what `DROPBOX_REFRESH_TOKEN` expects, so the server can mint its own short-lived access tokens indefinitely instead of you re-pasting one every few hours.
4. Set `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, and `DROPBOX_REFRESH_TOKEN`.

Without Dropbox credentials configured, Drive links keep working exactly as before — a gallery request just 400s if someone pastes a Dropbox link.

> **Note:** the Dropbox provider is implemented against Dropbox's documented HTTP API (`files/list_folder` with a `shared_link` arg, `files/get_thumbnail_v2` with a `link` resource, `sharing/get_shared_link_file`) but hasn't been exercised against a live Dropbox app yet — test it against a real shared folder before relying on it for a client delivery.

### Cloudflare + Backblaze B2 CDN setup (optional but recommended)

1. Create a **public** B2 bucket (files are already public via the Drive share link).
2. Note the bucket **Endpoint** and **Friendly URL** host from the bucket details page.
3. Create an **App Key** scoped to that bucket (Read + Write) — this gives you `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`.
4. In Cloudflare: add a **CNAME** record pointing to the B2 Friendly URL host, set to **Proxied** (orange cloud) — this is what triggers free egress under the [Bandwidth Alliance](https://www.cloudflare.com/bandwidth-alliance/).
5. Set SSL/TLS encryption mode to **Full**.
6. Set `CDN_BASE_URL` = `https://cdn.yourdomain.com/file/luxsync-cache`.

Without `CDN_BASE_URL`, images are still cached in B2/R2 — they're just proxied through this server on every request instead of redirected.

## Project Structure

```
luxsync-v3/
├── main.py                                    # FastAPI app — provider-agnostic API routes
├── providers/                                 # One module per gallery source
│   ├── __init__.py                            # Interface every provider module implements
│   ├── drive.py                               # Google Drive (API key)
│   └── dropbox_provider.py                    # Dropbox (OAuth2 app token)
├── cache.py                                   # S3-compatible cache (get/put bytes + JSON)
├── index.html                                 # Single-file frontend (no build step)
├── requirements.txt
├── Procfile                                   # Zeabur / Heroku process definition
├── .env.example                               # Required/optional env vars
├── LICENSE                                    # AGPLv3
├── COMMERCIAL-LICENSE.md                      # Commercial licensing overview
├── COMMERCIAL-LICENSE-AGREEMENT-TEMPLATE.md   # Commercial agreement template
├── NOTICE
└── .gitignore
```

## Adding a provider

Every gallery source is a module in `providers/` exposing the same five functions (documented in `providers/__init__.py`): `parse_source(url)`, `validate_ref(ref)`, `list_gallery(source_id)`, `get_thumb(file_ref)` / `get_full(file_ref)`, and `stream_download(file_ref)`. `main.py` never contains source-specific logic — it just tries each provider's `parse_source()` against a pasted URL and dispatches every subsequent call to whichever one matched. To add a new source (Imgur, for instance):

1. Add `providers/imgur.py` implementing the interface.
2. Register it in the `PROVIDERS` dict at the top of `main.py`.
3. Nothing in `index.html` needs to change — it already treats `provider` as an opaque string round-tripped from the gallery-resolve response into every thumb/full/download/zip URL.

Not every file host fits this model. Dropbox and Imgur both expose a documented API for reading someone else's public share without OAuth-ing as them, which is what this provider shape assumes. Services like WeTransfer don't expose that (their API is for creating transfers, not reading arbitrary shared ones) and MEGA only has an unofficial client-side-decryption library — those would need a different integration shape, if they're feasible at all.

## Deployment

Deployed on Zeabur via GitHub CI/CD. The `Procfile` defines the web process. Push to `main` triggers deploy.

## Status / Roadmap

**Done**

- [x] FastAPI backend with server-side Drive API key
- [x] Folder listing and image caching in S3-compatible object storage (B2 / R2)
- [x] Optional Cloudflare CDN redirect for zero-proxy cache hits
- [x] True masonry layout with sort dropdown
- [x] Lightbox preview
- [x] Multi-select streaming zip download (stream-zip, zero buffering), including Shift-click range select and gallery-named zip files
- [x] Shareable gallery links
- [x] Per-IP rate limiting on all routes
- [x] EXIF metadata display (dimensions, camera/lens, exposure) in the lightbox
- [x] Provider abstraction (`providers/`) with Dropbox as the second gallery source alongside Drive

**Future Roadmap**

Config & testing

- No test files found — even a minimal smoke test for the cache and rate-limit logic would help catch regressions
- No CI pipeline (lint/test on push) — worth adding now that there's a `main` branch deploy trigger
- Dropbox provider needs testing against a live app + shared folder — implemented from documented API shapes but unverified end-to-end

Gallery features

- Imgur provider (public albums, no OAuth needed — closest fit to the existing provider interface)
- Password-protected or expiring gallery links, for clients who shouldn't get an indefinite public URL
- Client favorites/starring, so a client can flag their picks without needing the zip download
- Virtualized/paginated grid for very large folders (current masonry renders everything at once)
- Optional watermarking on preview/thumbnail images, full-res only on download

Ops & delivery

- WebP/AVIF negotiation for cached images to cut storage and bandwidth further
- Dockerfile for local/self-hosted runs outside Zeabur, relevant now that AGPLv3 self-hosting is an explicit use case
- Basic usage/audit logging per gallery (useful for the commercial-license track)

## Changelog

Summarised from commit history, most recent first. Versions follow `0.MINOR.PATCH` — MINOR for new features/architecture changes, PATCH for fixes.

- **v0.7.0 — 2026-08-02 (multi-provider galleries)** — Introduced a `providers/` abstraction so `main.py` no longer hardcodes Drive-specific logic; added Dropbox as a second gallery source (public shared-folder links, read via one app-owned OAuth2 token so visitors never authenticate). Gallery resolution moved from `GET /api/gallery/{folder_id}` to `POST /api/gallery` accepting a raw pasted URL (or a `{provider, source}` pair for share-link reloads), which tries each provider in turn. All image/download routes now carry a `{provider}` segment. Old `?folder=` share links still work.
- **v0.6.0 — 2026-08-02 (gallery UX)** — Fixed the 5-column grid toggle rendering only 4 columns; renamed the toggle buttons to "View 3/5 Columns". Added a hint explaining hover-to-select and Shift-click range selection (select one photo, Shift-click another to select everything in between). Lightbox now shows filename and EXIF (dimensions, camera, focal length, aperture, shutter speed, ISO). "Download All" now zips the whole gallery instead of downloading files one by one, chunked to respect the backend's max-files-per-zip limit. Zip downloads are now named after the gallery instead of `gallery.zip`. Added a closeable, animated toast prompting for a Google review shortly after any download. Replaced the footer tagline with a "Built by TheBooleanJulian" link to GitHub.
- **v0.5.0 — 2026-07-31 (licensing + docs)** — Dual licensed the project under AGPLv3 + a commercial license (previously MIT); added `LICENSE` (AGPLv3), `COMMERCIAL-LICENSE.md`, `COMMERCIAL-LICENSE-AGREEMENT-TEMPLATE.md`, and `NOTICE`. Added `.env.example` and fixed the Configuration table, which documented a nonexistent `S3_BUCKET_NAME` instead of the actual `S3_BUCKET`/`S3_REGION` vars read in `cache.py`. Reworked the changelog to carry semver version numbers and expanded the roadmap section.
- **v0.4.1 — 2026-07-18 (cache stability)** — Dropped all S3 existence pre-checks (`exists()` and ranged `GetObject`) after both produced false positives against B2 on empty buckets; plain `GetObject` is now the only check. Cache write failures now log loudly without crashing the request; switched diagnostics to `print()` for reliable visibility in Zeabur logs.
- **v0.4.0 — 2026-07-17 (zip download + CDN)** — Added multi-select zip download (streaming via `stream-zip`, zero memory buffering) and Cloudflare-fronted B2/R2 CDN redirect for cache-hit image requests.
- **v0.3.0 — 2026-07-17 (backend)** — Moved Drive API key server-side behind a full FastAPI backend with httpx proxying, per-IP rate limiting via `slowapi`, and S3-compatible image caching (B2 / R2).
- **v0.2.0 — 2026-07-17 (frontend polish)** — Replaced CSS grid with true masonry layout; fixed single-column collapse regression; added sort dropdown; real folder name shown in the header; shareable gallery links replacing the old "New Link" button; moved the API key field from manual paste to env-backed config generated at build time.
- **v0.1.0 — 2026-07-12 (initial app)** — Added LuxSync v3 gallery app, single-file `index.html` frontend, and initial project docs.

## License

This project is dual licensed.

- Community Edition — [GNU Affero General Public License v3 (AGPLv3)](LICENSE). Free to use, modify, and self-host. If you distribute a modified version or run it as a network service, you must make the corresponding source available.
- Commercial License — for organisations that want to embed, modify, or distribute this software without AGPLv3's obligations. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

---

<div align="center">
<sub>Built by <a href="https://github.com/TheBooleanJulian">@TheBooleanJulian</a></sub>
</div>