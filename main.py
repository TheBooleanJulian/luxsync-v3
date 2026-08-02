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

import json
import os
import re
from datetime import datetime
from stat import S_IFREG

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from stream_zip import ZIP_32, async_stream_zip

import cache
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

limiter = Limiter(key_func=get_remote_address)
app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


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


@app.get("/api/download/{provider_name}/{file_ref}")
@limiter.limit("60/minute")
async def download_file(request: Request, provider_name: str, file_ref: str, name: str = "download"):
    provider = _get_provider(provider_name)
    provider.validate_ref(file_ref)

    safe_name = name.replace('"', "")
    return StreamingResponse(
        provider.stream_download(file_ref),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )


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
):
    provider_mod = _get_provider(provider)
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


# Logo/favicon assets only — not the whole repo (which would expose
# main.py, cache.py, etc.).
app.mount("/static", StaticFiles(directory="static"), name="static")


# The frontend is a single self-contained file — serve it directly rather
# than mounting the whole repo (which would expose main.py, cache.py, etc.).
@app.get("/")
async def serve_index():
    return FileResponse("index.html")
