"""Google Drive provider — reads public (link-shared) folders via a
server-side API key. See providers/__init__.py for the interface every
provider module implements.
"""

import os
import re

import httpx
from fastapi import HTTPException

DRIVE_API_KEY = os.environ.get("DRIVE_API_KEY", "")
DRIVE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{10,}$")

_URL_PATTERNS = [
    re.compile(r"/folders/([a-zA-Z0-9_-]{10,})"),
    re.compile(r"[?&]id=([a-zA-Z0-9_-]{10,})"),
]


def parse_source(url: str) -> str | None:
    for pattern in _URL_PATTERNS:
        m = pattern.search(url)
        if m:
            return m.group(1)
    # bare ID pasted directly
    if DRIVE_ID_RE.match(url.strip()):
        return url.strip()
    return None


def validate_ref(ref: str) -> None:
    if not DRIVE_ID_RE.match(ref):
        raise HTTPException(400, "Invalid ID")


async def _drive_get(path: str, params: dict) -> dict:
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


async def list_gallery(source_id: str) -> dict:
    folder = await _drive_get(f"files/{source_id}", {"fields": "name"})

    fields = "nextPageToken,files(id,name,imageMediaMetadata,createdTime,modifiedTime,mimeType)"
    q = f"'{source_id}' in parents and mimeType contains 'image/' and trashed = false"
    all_files = []
    page_token = ""
    while True:
        params = {"q": q, "fields": fields, "pageSize": 1000}
        if page_token:
            params["pageToken"] = page_token
        data = await _drive_get("files", params)
        all_files.extend(data.get("files", []))
        page_token = data.get("nextPageToken", "")
        if not page_token:
            break

    return {"name": folder.get("name") or "Gallery", "files": all_files}


async def _fetch_public_image(file_ref: str, size_param: str) -> tuple[bytes, str]:
    url = f"https://drive.google.com/thumbnail?id={file_ref}&sz={size_param}"
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        res = await client.get(url)
    if res.status_code != 200:
        raise HTTPException(404, "Image not found or folder is no longer public")
    return res.content, res.headers.get("content-type", "image/jpeg")


async def get_thumb(file_ref: str) -> tuple[bytes, str]:
    return await _fetch_public_image(file_ref, "w600")


async def get_full(file_ref: str) -> tuple[bytes, str]:
    return await _fetch_public_image(file_ref, "w2200")


async def stream_download(file_ref: str):
    url = f"https://drive.google.com/uc?export=download&id={file_ref}"
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        async with client.stream("GET", url) as res:
            if res.status_code != 200:
                raise HTTPException(404, f"File {file_ref} not found or not public")
            async for chunk in res.aiter_bytes():
                yield chunk
