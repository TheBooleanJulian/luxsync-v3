"""LuxSync v3 backend.

Keeps the Google Drive API key server-side only. The browser never sees it —
it calls these endpoints instead, which proxy and cache Drive so that:
  - `files.list` / `files.get` (the only calls that actually spend Drive API
    quota) are cached per folder for FOLDER_CACHE_TTL_SECONDS.
  - Thumbnails/full images are fetched from Drive's public (keyless)
    thumbnail endpoint once, then cached in S3-compatible object storage
    (Cloudflare R2 / Backblaze B2) so repeat visits never touch Drive again.
  - Downloads are streamed through this server rather than linking straight
    to drive.google.com, so everything is rate-limited per IP in one place.
"""

import json
import os
import re
from datetime import datetime
from stat import S_IFREG

import httpx
from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from stream_zip import ZIP_32, async_stream_zip

import cache

DRIVE_API_KEY = os.environ.get("DRIVE_API_KEY", "")
FOLDER_CACHE_TTL = int(os.environ.get("FOLDER_CACHE_TTL_SECONDS", "600"))
DRIVE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{10,}$")

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


def validate_drive_id(drive_id: str) -> None:
    if not DRIVE_ID_RE.match(drive_id):
        raise HTTPException(400, "Invalid ID")


async def drive_get(path: str, params: dict) -> dict:
    if not DRIVE_API_KEY:
        raise HTTPException(500, "Server is missing DRIVE_API_KEY")
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get(
            f"https://www.googleapis.com/drive/v3/{path}",
            params={**params, "key": DRIVE_API_KEY},
        )
    if res.status_code != 200:
        try:
            detail = res.json().get("error", {}).get("message", "Drive API request failed")
        except ValueError:
            detail = "Drive API request failed"
        raise HTTPException(res.status_code if res.status_code < 500 else 502, detail)
    return res.json()


@app.get("/api/gallery/{folder_id}")
@limiter.limit("20/minute")
async def get_gallery(request: Request, folder_id: str):
    validate_drive_id(folder_id)

    cache_key = f"folder-cache/{folder_id}.json"
    cached = cache.get_json(cache_key, FOLDER_CACHE_TTL)
    if cached is not None:
        return cached

    folder = await drive_get(f"files/{folder_id}", {"fields": "name"})

    fields = "nextPageToken,files(id,name,imageMediaMetadata,createdTime,modifiedTime,mimeType)"
    q = f"'{folder_id}' in parents and mimeType contains 'image/' and trashed = false"
    all_files = []
    page_token = ""
    while True:
        params = {"q": q, "fields": fields, "pageSize": 1000}
        if page_token:
            params["pageToken"] = page_token
        data = await drive_get("files", params)
        all_files.extend(data.get("files", []))
        page_token = data.get("nextPageToken", "")
        if not page_token:
            break

    result = {"name": folder.get("name") or "Gallery", "files": all_files}
    cache.put_json(cache_key, result)
    return result


def _cdn_redirect(cache_key: str) -> Response:
    return RedirectResponse(f"{CDN_BASE_URL}/{cache_key}", status_code=302)


async def proxy_public_image(file_id: str, size_param: str, cache_prefix: str) -> Response:
    validate_drive_id(file_id)
    cache_key = f"{cache_prefix}/{file_id}"

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

    # Cache miss: fetch from Drive's public (keyless) thumbnail endpoint once,
    # store it, then serve it (via CDN redirect if configured, else directly).
    url = f"https://drive.google.com/thumbnail?id={file_id}&sz={size_param}"
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        res = await client.get(url)
    if res.status_code != 200:
        raise HTTPException(404, "Image not found or folder is no longer public")

    content_type = res.headers.get("content-type", "image/jpeg")
    cached_ok = cache.put_bytes(cache_key, res.content, content_type)

    # Only redirect to the CDN if the upload actually succeeded — redirecting
    # to an object that was never written would just 404 at Cloudflare/B2.
    if CDN_BASE_URL and cached_ok:
        return _cdn_redirect(cache_key)
    return Response(content=res.content, media_type=content_type,
                     headers={"Cache-Control": "public, max-age=2592000, immutable"})


@app.get("/api/thumb/{file_id}")
@limiter.limit("300/minute")
async def get_thumb(request: Request, file_id: str):
    return await proxy_public_image(file_id, "w600", "thumb")


@app.get("/api/full/{file_id}")
@limiter.limit("120/minute")
async def get_full(request: Request, file_id: str):
    return await proxy_public_image(file_id, "w2200", "full")


@app.get("/api/download/{file_id}")
@limiter.limit("60/minute")
async def download_file(request: Request, file_id: str, name: str = "download"):
    validate_drive_id(file_id)
    url = f"https://drive.google.com/uc?export=download&id={file_id}"

    async def stream():
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            async with client.stream("GET", url) as res:
                async for chunk in res.aiter_bytes():
                    yield chunk

    safe_name = name.replace('"', "")
    return StreamingResponse(
        stream(),
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


@app.post("/api/download-zip")
@limiter.limit("10/minute")
async def download_zip(request: Request, files: str = Form(...)):
    try:
        file_list = json.loads(files)
    except ValueError:
        raise HTTPException(400, "Invalid file list")
    if not isinstance(file_list, list) or not file_list:
        raise HTTPException(400, "No files given")
    if len(file_list) > MAX_ZIP_FILES:
        raise HTTPException(400, f"Too many files (max {MAX_ZIP_FILES} per zip)")

    ids = []
    names = []
    for item in file_list:
        file_id = item.get("id", "")
        validate_drive_id(file_id)
        ids.append(file_id)
        names.append(item.get("name") or file_id)
    names = _dedupe_names(names)

    async def member_content(file_id: str):
        url = f"https://drive.google.com/uc?export=download&id={file_id}"
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            async with client.stream("GET", url) as res:
                if res.status_code != 200:
                    raise HTTPException(404, f"File {file_id} not found or not public")
                async for chunk in res.aiter_bytes():
                    yield chunk

    async def members():
        now = datetime.now()
        for file_id, name in zip(ids, names):
            yield (name, now, S_IFREG | 0o644, ZIP_32, member_content(file_id))

    return StreamingResponse(
        async_stream_zip(members()),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="gallery.zip"'},
    )


# The frontend is a single self-contained file — serve it directly rather
# than mounting the whole repo (which would expose main.py, cache.py, etc.).
@app.get("/")
async def serve_index():
    return FileResponse("index.html")
