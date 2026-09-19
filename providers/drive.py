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


FOLDER_MIME = "application/vnd.google-apps.folder"
# Safety cap on how many subfolders one gallery walk will visit — shoots are
# nested at most a couple of levels deep (event > per-person), this just
# guards against a pathological/circular tree.
MAX_FOLDERS = 300


async def _list_children(parent_id: str) -> list[dict]:
    fields = "nextPageToken,files(id,name,imageMediaMetadata,createdTime,modifiedTime,mimeType)"
    q = f"'{parent_id}' in parents and trashed = false"
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
    return all_files


async def _collect_images(root_id: str) -> list[dict]:
    """Walk the folder tree rooted at root_id, gathering every image found —
    directly inside it or in any subfolder (galleries are often organized as
    an event folder full of per-person/per-shoot subfolders with no images
    of their own)."""
    images = []
    queue = [root_id]
    visited = 0
    while queue and visited < MAX_FOLDERS:
        folder_id = queue.pop(0)
        visited += 1
        for child in await _list_children(folder_id):
            if child.get("mimeType") == FOLDER_MIME:
                queue.append(child["id"])
            elif (child.get("mimeType") or "").startswith("image/"):
                images.append(child)
    return images


async def list_gallery(source_id: str) -> dict:
    folder = await _drive_get(f"files/{source_id}", {"fields": "name"})
    all_files = await _collect_images(source_id)
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
