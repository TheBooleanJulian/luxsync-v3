<div align="center">

# LuxSync v3

**A premium, dependency-free photo gallery that turns any public Google Drive folder into a scrollable, previewable, downloadable client gallery.**

![Version](https://img.shields.io/badge/version-0.6.0-00D4C8)
![Python](https://img.shields.io/badge/-Python-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/-FastAPI-009688?logo=fastapi&logoColor=white)
![Zeabur](https://img.shields.io/badge/-Zeabur-6C5CE7)
![License](https://img.shields.io/badge/license-AGPLv3%20%2B%20Commercial-00D4C8.svg)

</div>

---

## What it does

LuxSync v3 lets photographers hand a client a single link — the client pastes their shared Google Drive folder URL into the gallery, and immediately gets a fully styled, scrollable masonry grid with lightbox preview, sort controls, multi-select, and bulk zip download. The Drive API key lives server-side only; the browser never touches Google directly. Thumbnails and full images are cached permanently in S3-compatible object storage (Backblaze B2 or Cloudflare R2), and when a Cloudflare-proxied CDN URL is configured, repeat image requests bypass the server entirely — egress from B2 is free under the Bandwidth Alliance.

## Features

- **Server-side API key** — the browser calls FastAPI endpoints; Google Drive credentials never reach the client
- **Folder metadata + file list caching** — Drive API quota is spent once per folder per TTL window (default 10 min), cache hits cost zero quota
- **Permanent image cache in S3-compatible storage** — thumbnails and full images are fetched from Drive once and stored; every subsequent request hits the cache
- **Optional Cloudflare CDN redirect** — when `CDN_BASE_URL` is set, cache-hit responses are `302`s straight to the CDN instead of proxied bytes, dropping server bandwidth to near zero
- **True masonry layout** — photos fill rows without dead space; sorts left-to-right by row; toggle between 3 and 5 columns
- **Sort dropdown** — reorder the gallery on the fly
- **Lightbox preview** — click any photo for a full-size overlay with filename and EXIF (dimensions, camera, focal length, aperture, shutter speed, ISO)
- **Multi-select zip download** — click to select individual photos, or select one and Shift-click another to select the whole range in between; stream a zip built on the fly via `stream-zip`, named after the gallery, with nothing buffered in memory or on disk
- **Download All** — zips the entire gallery the same way, chunked automatically for very large folders
- **Single-file download** — selecting exactly one photo skips the zip and streams the original directly
- **Per-IP rate limiting** — every route is independently limited via `slowapi`; one heavy visitor degrades gracefully without burning Drive quota for everyone
- **Shareable gallery links** — encoded folder ID in the URL so a gallery view is directly linkable
- **Zero database, no build step** — FastAPI backend + a single self-contained `index.html`

## Tech Stack

| Layer | Choice |
|---|---|
| Backend | FastAPI + httpx + slowapi |
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

> The Drive folder must be shared as **Anyone with the link — Viewer**.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `DRIVE_API_KEY` | ✅ | Google Drive API v3 key (never sent to the browser) |
| `S3_ACCESS_KEY_ID` | ✅ | Access key for your B2 / R2 bucket |
| `S3_SECRET_ACCESS_KEY` | ✅ | Secret key for your B2 / R2 bucket |
| `S3_ENDPOINT_URL` | ✅ | S3-compatible endpoint URL (e.g. `https://s3.us-west-004.backblazeb2.com`) |
| `S3_BUCKET` | ✅ | Bucket name for image cache (e.g. `luxsync-cache`) |
| `S3_REGION` | ❌ | Region passed to the S3 client (default `auto`) |
| `CDN_BASE_URL` | ❌ | Cloudflare-proxied base URL for cached images (e.g. `https://cdn.yourdomain.com/file/luxsync-cache`). When set, cache-hit image requests are redirected to the CDN instead of proxied. |
| `FOLDER_CACHE_TTL_SECONDS` | ❌ | How long to cache folder listings (default `600`) |

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
├── main.py                                    # FastAPI app — all API routes
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

**Future Roadmap**

Config & testing

- No test files found — even a minimal smoke test for the cache and rate-limit logic would help catch regressions
- No CI pipeline (lint/test on push) — worth adding now that there's a `main` branch deploy trigger

Gallery features

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