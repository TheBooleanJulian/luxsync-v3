"""Google Drive provider — reads public (link-shared) folders via a
server-side API key. See providers/__init__.py for the interface every
provider module implements.
"""

import asyncio
import logging
import os
import random
import re
import time

import httpx
from fastapi import HTTPException

from errors import LuxError

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
    fields = "nextPageToken,files(id,name,imageMediaMetadata,videoMediaMetadata,createdTime,modifiedTime,mimeType)"
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


async def _collect_media(root_id: str) -> list[dict]:
    """Walk the folder tree rooted at root_id, gathering every image/video
    found — directly inside it or in any subfolder (galleries are often
    organized as an event folder full of per-person/per-shoot subfolders
    with no media of their own)."""
    media = []
    queue = [root_id]
    visited = 0
    while queue and visited < MAX_FOLDERS:
        folder_id = queue.pop(0)
        visited += 1
        for child in await _list_children(folder_id):
            if child.get("mimeType") == FOLDER_MIME:
                queue.append(child["id"])
            elif (child.get("mimeType") or "").startswith(("image/", "video/")):
                media.append(child)
    return media


async def list_gallery(source_id: str) -> dict:
    folder = await _drive_get(f"files/{source_id}", {"fields": "name"})
    all_files = await _collect_media(source_id)
    return {"name": folder.get("name") or "Gallery", "files": all_files}


# ---- quota protection ----
# Every visitor and every gallery shares one API key and one server IP, so to
# Drive it all looks like a single heavy user. Drive throttles request *bursts*
# (403 userRateLimitExceeded / 429) long before the documented per-minute
# quota (325k units/user, 200 per download) is anywhere near, and a 300-photo
# zip is ~300 requests in seconds. So: pace request starts globally, retry
# only errors that are actually transient (honouring Retry-After, with
# jitter), and log Google's real error reason so throttling is diagnosable.
log = logging.getLogger("luxsync.drive")

# Minimum gap between Drive API download request starts, across all visitors.
MIN_REQUEST_INTERVAL = int(os.environ.get("DRIVE_MIN_INTERVAL_MS", "120")) / 1000
MAX_ATTEMPTS = 3
_RATE_LIMIT_REASONS = {"userRateLimitExceeded", "rateLimitExceeded", "sharingRateLimitExceeded"}
_pace_lock = asyncio.Lock()
_last_request = 0.0
# Thumbnails come from a different endpoint (not API quota) but 300 at once on
# a first gallery view gets throttled too; they're short, so a plain cap works.
_thumb_slots = asyncio.Semaphore(10)


async def _pace() -> None:
    global _last_request
    async with _pace_lock:
        wait = _last_request + MIN_REQUEST_INTERVAL - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        _last_request = time.monotonic()


async def _error_reason(res: httpx.Response) -> str:
    """Google's machine-readable reason (e.g. userRateLimitExceeded,
    downloadQuotaExceeded) from an error response, or ''."""
    try:
        await res.aread()
        errors = res.json().get("error", {}).get("errors") or []
        return errors[0].get("reason", "") if errors else ""
    except Exception:
        return ""


def _is_transient(status: int, reason: str) -> bool:
    return status in (429, 500, 502, 503, 504) or reason in _RATE_LIMIT_REASONS


async def _backoff(attempt: int, res: httpx.Response) -> None:
    try:
        delay = min(float(res.headers.get("retry-after", "")), 10)
    except ValueError:
        delay = 1.0 * 2 ** attempt
    await asyncio.sleep(delay + random.random() * 0.5)


async def _fetch_public_image(file_ref: str, size_param: str) -> tuple[bytes, str]:
    url = f"https://drive.google.com/thumbnail?id={file_ref}&sz={size_param}"
    async with _thumb_slots:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            for attempt in range(MAX_ATTEMPTS):
                res = await client.get(url)
                if res.status_code == 200:
                    return res.content, res.headers.get("content-type", "image/jpeg")
                log.warning("Drive thumbnail %s -> %s (attempt %d)", file_ref, res.status_code, attempt + 1)
                if not _is_transient(res.status_code, "") or attempt == MAX_ATTEMPTS - 1:
                    break
                await _backoff(attempt, res)
    if res.status_code == 429 or res.status_code >= 500:
        raise LuxError(503, "LS-DRV-RATE", f"thumbnail {file_ref} status={res.status_code}")
    raise LuxError(404, "LS-DRV-GONE", f"thumbnail {file_ref} status={res.status_code}")


async def get_thumb(file_ref: str) -> tuple[bytes, str]:
    return await _fetch_public_image(file_ref, "w600")


async def get_full(file_ref: str) -> tuple[bytes, str]:
    return await _fetch_public_image(file_ref, "w2200")


async def stream_download(file_ref: str):
    # Deliberately not drive.google.com/uc?export=download: for any file
    # past a few MB (i.e. basically every video) that URL serves an HTML
    # "can't scan this file for viruses" interstitial instead of the file,
    # still with a 200 status — which main.py would then stream to the
    # client mislabeled as video/mp4, hanging the <video> element forever.
    # The API v3 alt=media download has no such interstitial.
    if not DRIVE_API_KEY:
        raise LuxError(500, "LS-DRV-CFG", "DRIVE_API_KEY is not set")
    url = f"https://www.googleapis.com/drive/v3/files/{file_ref}"
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        # This is the only retry layer for opening a download (callers retry
        # only mid-transfer cuts), so one file costs at most MAX_ATTEMPTS
        # Drive requests even while throttled. Retries happen before any byte
        # is sent; after that a failure can only surface as a truncated file.
        for attempt in range(MAX_ATTEMPTS):
            await _pace()
            req = client.build_request("GET", url, params={"alt": "media", "key": DRIVE_API_KEY})
            res = await client.send(req, stream=True)
            if res.status_code == 200:
                break
            status = res.status_code
            reason = await _error_reason(res)
            log.warning("Drive download %s -> %s %s (attempt %d/%d)",
                        file_ref, status, reason or "-", attempt + 1, MAX_ATTEMPTS)
            if reason == "downloadQuotaExceeded":
                # Google's per-file download cap; retrying only digs deeper.
                await res.aclose()
                raise LuxError(503, "LS-DRV-FILE", f"file={file_ref}")
            if not _is_transient(status, reason):
                await res.aclose()
                raise LuxError(404, "LS-DRV-GONE", f"file={file_ref} status={status} reason={reason or '-'}")
            if attempt == MAX_ATTEMPTS - 1:
                await res.aclose()
                raise LuxError(503, "LS-DRV-RATE", f"file={file_ref} status={status} reason={reason or '-'}")
            await _backoff(attempt, res)
            await res.aclose()
        try:
            async for chunk in res.aiter_bytes():
                yield chunk
        finally:
            await res.aclose()


async def stream_range(file_ref: str, range_header: str | None):
    """Like stream_download, but forwards an incoming Range header to Drive
    so the client gets a real 206 response. Without this, <video> has to
    wait for (and we have to proxy) the entire file before playback can
    start, and Safari refuses to play at all without range support."""
    if not DRIVE_API_KEY:
        raise HTTPException(500, "Server is missing DRIVE_API_KEY")
    url = f"https://www.googleapis.com/drive/v3/files/{file_ref}"
    req_headers = {"Range": range_header} if range_header else {}
    client = httpx.AsyncClient(timeout=60, follow_redirects=True)
    req = client.build_request("GET", url, params={"alt": "media", "key": DRIVE_API_KEY}, headers=req_headers)
    res = await client.send(req, stream=True)
    if res.status_code not in (200, 206):
        await res.aclose()
        await client.aclose()
        raise HTTPException(404, f"File {file_ref} not found or not public")

    async def body():
        try:
            async for chunk in res.aiter_bytes():
                yield chunk
        finally:
            await res.aclose()
            await client.aclose()

    return res.status_code, res.headers.get("content-type"), res.headers.get("content-range"), res.headers.get("content-length"), body()
