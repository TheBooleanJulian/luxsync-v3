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

import os
import re

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

import cache

DRIVE_API_KEY = os.environ.get("DRIVE_API_KEY", "")
FOLDER_CACHE_TTL = int(os.environ.get("FOLDER_CACHE_TTL_SECONDS", "600"))
DRIVE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{10,}$")

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


async def proxy_public_image(file_id: str, size_param: str, cache_prefix: str) -> Response:
    validate_drive_id(file_id)

    cache_key = f"{cache_prefix}/{file_id}"
    cached = cache.get_bytes(cache_key)
    if cached:
        data, content_type = cached
        return Response(content=data, media_type=content_type,
                         headers={"Cache-Control": "public, max-age=2592000, immutable"})

    url = f"https://drive.google.com/thumbnail?id={file_id}&sz={size_param}"
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        res = await client.get(url)
    if res.status_code != 200:
        raise HTTPException(404, "Image not found or folder is no longer public")

    content_type = res.headers.get("content-type", "image/jpeg")
    cache.put_bytes(cache_key, res.content, content_type)
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


# The frontend is a single self-contained file — serve it directly rather
# than mounting the whole repo (which would expose main.py, cache.py, etc.).
@app.get("/")
async def serve_index():
    return FileResponse("index.html")
