"""LuxSync v3 backend.

Keeps every gallery source's API credentials server-side only — the browser
never sees them. It calls these provider-agnostic endpoints instead, which
dispatch to a provider module (providers/drive.py, providers/dropbox_provider.py,
...) so that:
  - Folder/file listing (the only calls that spend API quota) is cached per
    source for FOLDER_CACHE_TTL_SECONDS.
  - Thumbnails/full images are fetched from the source once, then cached in
    S3-compatible object storage (Cloudflare R2 / Backblaze B2) so repeat
    visits never touch the source again.
  - Downloads are streamed through this server rather than linking straight
    to the source, so everything is rate-limited per IP in one place.
"""

import csv
import io
import json
import mimetypes
import os
import re
import secrets
from datetime import datetime
from stat import S_IFREG

from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from stream_zip import ZIP_32, async_stream_zip

import cache
import downloads
import providers.drive as drive_provider
import providers.dropbox_provider as dropbox_provider

PROVIDERS = {"drive": drive_provider, "dropbox": dropbox_provider}

FOLDER_CACHE_TTL = int(os.environ.get("FOLDER_CACHE_TTL_SECONDS", "600"))

# Cloudflare-fronted Backblaze B2 (or R2) base URL, e.g.
# "https://cdn.example.com/file/luxsync-cache" — when set, cached
# thumbnails/full images are served by redirecting the browser straight to
# this CDN instead of proxying bytes through this server. See README for
# the B2 + Cloudflare setup (Bandwidth Alliance = free egress from B2, but
# only for requests that actually route through Cloudflare's proxy).
CDN_BASE_URL = os.environ.get("CDN_BASE_URL", "").rstrip("/")
MAX_ZIP_FILES = 200

# Credentials for /admin (HTTP Basic). ADMIN_PASSWORD unset = admin disabled.
# ADMIN_USERNAME is optional: when set it must match too, otherwise any
# username is accepted.
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "")

limiter = Limiter(key_func=get_remote_address)
app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Every response here is public gallery metadata/images gated only by
# knowing the source folder ID, not by origin — so a wildcard is fine. This
# lets any site in the fleet (or elsewhere) call /api/gallery etc. directly
# from browser JS, not just from a server-side build step.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def _get_provider(name: str):
    provider = PROVIDERS.get(name)
    if provider is None:
        raise HTTPException(400, "Unknown provider")
    return provider


def _resolve_source(url: str) -> tuple[str, str]:
    for name, provider in PROVIDERS.items():
        source_id = provider.parse_source(url)
        if source_id:
            return name, source_id
    raise HTTPException(
        400,
        "Could not recognize that link. Paste a public Google Drive folder "
        "or Dropbox shared folder link.",
    )


class GalleryRequest(BaseModel):
    url: str | None = None
    provider: str | None = None
    source: str | None = None


@app.post("/api/gallery")
@limiter.limit("20/minute")
async def get_gallery(request: Request, payload: GalleryRequest):
    if payload.provider and payload.source:
        provider_name, source_id = payload.provider, payload.source
        provider = _get_provider(provider_name)
    elif payload.url:
        provider_name, source_id = _resolve_source(payload.url)
        provider = PROVIDERS[provider_name]
    else:
        raise HTTPException(400, "Missing url")

    provider.validate_ref(source_id)

    cache_key = f"{provider_name}/folder-cache/{source_id}.json"
    cached = cache.get_json(cache_key, FOLDER_CACHE_TTL)
    if cached is not None:
        return {"provider": provider_name, "source": source_id, **cached}

    result = await provider.list_gallery(source_id)
    cache.put_json(cache_key, result)
    return {"provider": provider_name, "source": source_id, **result}


def _cdn_redirect(cache_key: str) -> Response:
    return RedirectResponse(f"{CDN_BASE_URL}/{cache_key}", status_code=302)


async def _proxy_image(provider_name: str, file_ref: str, kind: str) -> Response:
    provider = _get_provider(provider_name)
    provider.validate_ref(file_ref)
    cache_key = f"{provider_name}/{kind}/{file_ref}"

    # Cache hit: a plain GetObject is the one S3 operation every
    # S3-compatible provider is guaranteed to get right (HeadObject and
    # ranged-GetObject existence checks against B2 both produced false
    # positives for keys that were never written — see commit history).
    cached = cache.get_bytes(cache_key)
    if cached:
        if CDN_BASE_URL:
            return _cdn_redirect(cache_key)
        data, content_type = cached
        return Response(content=data, media_type=content_type,
                         headers={"Cache-Control": "public, max-age=2592000, immutable"})

    # Cache miss: fetch from the source once, store it, then serve it (via
    # CDN redirect if configured, else directly).
    fetch = provider.get_thumb if kind == "thumb" else provider.get_full
    content, content_type = await fetch(file_ref)
    cached_ok = cache.put_bytes(cache_key, content, content_type)

    # Only redirect to the CDN if the upload actually succeeded — redirecting
    # to an object that was never written would just 404 at Cloudflare/B2.
    if CDN_BASE_URL and cached_ok:
        return _cdn_redirect(cache_key)
    return Response(content=content, media_type=content_type,
                     headers={"Cache-Control": "public, max-age=2592000, immutable"})


@app.get("/api/thumb/{provider_name}/{file_ref}")
@limiter.limit("300/minute")
async def get_thumb(request: Request, provider_name: str, file_ref: str):
    return await _proxy_image(provider_name, file_ref, "thumb")


@app.get("/api/full/{provider_name}/{file_ref}")
@limiter.limit("120/minute")
async def get_full(request: Request, provider_name: str, file_ref: str):
    return await _proxy_image(provider_name, file_ref, "full")


async def _stream_and_cache(provider, file_ref: str, cache_key: str, content_type: str):
    # Tees the source stream to the client while buffering it in memory, then
    # writes the full thing to the cache once it's done sending — so a video
    # is never fetched from Drive/Dropbox twice, but also never fully
    # buffered before the client starts receiving it. Fine for short clips;
    # a very large video held entirely in memory is the accepted tradeoff
    # for getting free-egress CDN redirects on repeat views (see README).
    chunks = []
    async for chunk in provider.stream_download(file_ref):
        chunks.append(chunk)
        yield chunk
    cache.put_bytes(cache_key, b"".join(chunks), content_type)


def _serve_range(data: bytes, content_type: str, range_header: str | None) -> Response:
    base_headers = {"Cache-Control": "public, max-age=2592000, immutable", "Accept-Ranges": "bytes"}
    if not range_header:
        return Response(content=data, media_type=content_type, headers=base_headers)

    size = len(data)
    try:
        start_s, _, end_s = range_header.removeprefix("bytes=").partition("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else size - 1
    except ValueError:
        start, end = 0, size - 1
    end = min(end, size - 1)
    chunk = data[start:end + 1]
    return Response(
        content=chunk, status_code=206, media_type=content_type,
        headers={**base_headers, "Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(len(chunk))},
    )


@app.get("/api/stream/{provider_name}/{file_ref}")
@limiter.limit("30/minute")
async def stream_video(request: Request, provider_name: str, file_ref: str, name: str = ""):
    provider = _get_provider(provider_name)
    provider.validate_ref(file_ref)
    cache_key = f"{provider_name}/video/{file_ref}"
    guessed_type = mimetypes.guess_type(name)[0] or "video/mp4"
    range_header = request.headers.get("range")

    cached = cache.get_bytes(cache_key)
    if cached:
        if CDN_BASE_URL:
            return _cdn_redirect(cache_key)
        data, content_type = cached
        return _serve_range(data, content_type, range_header)

    if range_header:
        # Forward the Range straight to the source so playback can start
        # immediately instead of waiting for (and us proxying) the whole
        # file — and so Safari, which refuses to play without a ranged
        # response, works at all. Not cached: a 206 is only part of the
        # file, and the Range is almost always present from the very first
        # request, so caching would otherwise rarely trigger for video at
        # all. The full-file cache still gets populated whenever a client
        # requests the whole thing (e.g. the download button).
        status, content_type, content_range, content_length, body = await provider.stream_range(file_ref, range_header)
        headers = {"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=2592000, immutable"}
        if content_range:
            headers["Content-Range"] = content_range
        if content_length:
            headers["Content-Length"] = content_length
        return StreamingResponse(body, status_code=status, media_type=content_type or guessed_type, headers=headers)

    return StreamingResponse(
        _stream_and_cache(provider, file_ref, cache_key, guessed_type),
        media_type=guessed_type,
        headers={"Cache-Control": "public, max-age=2592000, immutable", "Accept-Ranges": "bytes"},
    )


@app.get("/api/download/{provider_name}/{file_ref}")
@limiter.limit("60/minute")
async def download_file(
    request: Request, provider_name: str, file_ref: str, name: str = "download",
    email: str = "", optin: int = 0, source: str = "", gallery: str = "",
):
    provider = _get_provider(provider_name)
    provider.validate_ref(file_ref)
    clean_email = _require_email(email)
    downloads.log_download(
        email=clean_email, optin=bool(optin), provider=provider_name, source=source,
        gallery_name=gallery, kind="photo", filenames=[name], ip=get_remote_address(request),
    )

    safe_name = name.replace('"', "")
    return StreamingResponse(
        provider.stream_download(file_ref),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )


def _require_email(raw: str) -> str:
    email = downloads.normalize_email(raw)
    if email is None:
        raise HTTPException(400, "A valid email is required to download")
    return email


def _dedupe_names(names: list) -> list:
    """Give repeated filenames (Drive allows duplicates in one folder) a
    ' (2)', ' (3)', ... suffix so they don't collide as zip entries."""
    seen = {}
    result = []
    for name in names:
        count = seen.get(name, 0) + 1
        seen[name] = count
        if count == 1:
            result.append(name)
        else:
            if "." in name:
                base, ext = name.rsplit(".", 1)
                result.append(f"{base} ({count}).{ext}")
            else:
                result.append(f"{name} ({count})")
    return result


def _sanitize_zip_name(name: str) -> str:
    name = (name or "").strip()
    name = re.sub(r'[\r\n"\\/:*?<>|]', "", name)
    name = name.strip(". ")
    return name or "gallery"


@app.post("/api/download-zip")
@limiter.limit("10/minute")
async def download_zip(
    request: Request,
    files: str = Form(...),
    zip_name: str = Form("gallery"),
    provider: str = Form("drive"),
    email: str = Form(""),
    optin: int = Form(0),
    source: str = Form(""),
    gallery_name: str = Form(""),
    kind: str = Form("selected"),
    part: int = Form(0),
    total: int = Form(0),
):
    provider_mod = _get_provider(provider)
    clean_email = _require_email(email)
    if kind not in ("selected", "all"):
        raise HTTPException(400, "Invalid kind")
    try:
        file_list = json.loads(files)
    except ValueError:
        raise HTTPException(400, "Invalid file list")
    if not isinstance(file_list, list) or not file_list:
        raise HTTPException(400, "No files given")
    if len(file_list) > MAX_ZIP_FILES:
        raise HTTPException(400, f"Too many files (max {MAX_ZIP_FILES} per zip)")

    refs = []
    names = []
    for item in file_list:
        file_ref = item.get("id", "")
        provider_mod.validate_ref(file_ref)
        refs.append(file_ref)
        names.append(item.get("name") or file_ref)
    names = _dedupe_names(names)

    # A very large "Download All" is sent as several zips; log it once (part 0)
    # with the full file count rather than once per chunk.
    if part == 0:
        downloads.log_download(
            email=clean_email, optin=bool(optin), provider=provider, source=source,
            gallery_name=gallery_name, kind=kind, filenames=names,
            file_count=max(total, len(names)), ip=get_remote_address(request),
        )

    async def member_content(file_ref: str):
        async for chunk in provider_mod.stream_download(file_ref):
            yield chunk

    async def members():
        now = datetime.now()
        for file_ref, name in zip(refs, names):
            yield (name, now, S_IFREG | 0o644, ZIP_32, member_content(file_ref))

    zip_filename = f"{_sanitize_zip_name(zip_name)}.zip"

    return StreamingResponse(
        async_stream_zip(members()),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{zip_filename}"'},
    )


# ---------- admin dashboard ----------
_basic = HTTPBasic(auto_error=False)


def _require_admin(credentials: HTTPBasicCredentials | None = Depends(_basic)):
    if not ADMIN_PASSWORD:
        raise HTTPException(404, "Not found")
    if credentials is None:
        raise HTTPException(401, "Unauthorized", headers={"WWW-Authenticate": 'Basic realm="LuxSync admin"'})
    password_ok = secrets.compare_digest(credentials.password.encode(), ADMIN_PASSWORD.encode())
    username_ok = not ADMIN_USERNAME or secrets.compare_digest(
        credentials.username.encode(), ADMIN_USERNAME.encode()
    )
    if not (password_ok and username_ok):
        raise HTTPException(401, "Unauthorized", headers={"WWW-Authenticate": 'Basic realm="LuxSync admin"'})


@app.get("/admin", dependencies=[Depends(_require_admin)])
@limiter.limit("30/minute")
async def serve_admin(request: Request):
    return FileResponse("admin.html", headers={"Cache-Control": "no-store"})


@app.get("/api/admin/stats", dependencies=[Depends(_require_admin)])
@limiter.limit("60/minute")
async def admin_stats(request: Request):
    return downloads.stats()


@app.get("/api/admin/downloads", dependencies=[Depends(_require_admin)])
@limiter.limit("60/minute")
async def admin_downloads(request: Request, view: str = "gallery", q: str = "",
                          limit: int = 100, offset: int = 0):
    return downloads.list_downloads(view, q.strip(), min(max(limit, 1), 500), max(offset, 0))


@app.get("/api/admin/emails", dependencies=[Depends(_require_admin)])
@limiter.limit("60/minute")
async def admin_emails(request: Request, q: str = ""):
    return downloads.list_emails(q.strip())


def _csv_cell(value) -> str:
    # Emails/filenames are visitor-supplied; stop spreadsheets treating them as formulas.
    text = str(value)
    return "'" + text if text.startswith(("=", "+", "-", "@", "\t", "\r")) else text


@app.get("/api/admin/export.csv", dependencies=[Depends(_require_admin)])
@limiter.limit("10/minute")
async def admin_export(request: Request, view: str = "emails"):
    out = io.StringIO()
    writer = csv.writer(out)
    if view == "emails":
        writer.writerow(["email", "newsletter_optin", "downloads", "galleries", "first_seen", "last_seen"])
        for r in downloads.list_emails():
            writer.writerow([_csv_cell(r["email"]), r["optin"], r["downloads"], r["galleries"],
                             r["first_seen"], r["last_seen"]])
    else:
        writer.writerow(["time_utc", "email", "newsletter_optin", "gallery", "type", "files", "filenames"])
        for r in downloads.list_downloads("photo", limit=1_000_000)["items"] +                  downloads.list_downloads("gallery", limit=1_000_000)["items"]:
            writer.writerow([r["ts"], _csv_cell(r["email"]), r["optin"], _csv_cell(r["gallery_name"]),
                             r["kind"], r["file_count"], _csv_cell("; ".join(r["filenames"]))])
    return Response(
        out.getvalue(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="luxsync-{view}.csv"'},
    )


# Logo/favicon assets only — not the whole repo (which would expose
# main.py, cache.py, etc.).
app.mount("/static", StaticFiles(directory="static"), name="static")


# The frontend is a single self-contained file — serve it directly rather
# than mounting the whole repo (which would expose main.py, cache.py, etc.).
@app.get("/")
async def serve_index():
    return FileResponse("index.html")
