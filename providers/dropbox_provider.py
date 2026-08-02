"""Dropbox provider — reads public shared-folder links via one server-owned
app token, refreshed automatically, so visitors never need a Dropbox account
or their own token. See providers/__init__.py for the interface every
provider module implements.

Setup: create a Dropbox app at https://www.dropbox.com/developers/apps with
the `sharing.read` and `files.metadata.read` scopes, then generate a refresh
token for it (the standard OAuth2 authorization-code flow with
`token_access_type=offline`). Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET, and
DROPBOX_REFRESH_TOKEN — this app refreshes its own short-lived access token
from those automatically. For quick local testing you can instead set
DROPBOX_ACCESS_TOKEN to a token generated directly from the app console, but
those expire after a few hours.

Note: this talks to Dropbox's documented HTTP API (list_folder with a
shared_link arg, get_thumbnail_v2 with a link resource, and
sharing/get_shared_link_file) but hasn't been exercised against a live
Dropbox app — test against a real shared folder before relying on it.
"""

import base64
import json
import os
import re
import time

import httpx
from fastapi import HTTPException

DROPBOX_APP_KEY = os.environ.get("DROPBOX_APP_KEY", "")
DROPBOX_APP_SECRET = os.environ.get("DROPBOX_APP_SECRET", "")
DROPBOX_REFRESH_TOKEN = os.environ.get("DROPBOX_REFRESH_TOKEN", "")
DROPBOX_ACCESS_TOKEN = os.environ.get("DROPBOX_ACCESS_TOKEN", "")  # fallback, expires ~4h

_URL_RE = re.compile(r"https?://(?:www\.)?dropbox\.com/(?:scl/fo|sh)/\S+", re.IGNORECASE)
_REF_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_IMAGE_EXT_RE = re.compile(r"\.(jpe?g|png|gif|webp|heic|bmp|tiff?)$", re.IGNORECASE)

_token_cache = {"token": "", "expires_at": 0.0}


def parse_source(url: str) -> str | None:
    m = _URL_RE.search(url.strip())
    if not m:
        return None
    return _encode(m.group(0))


def validate_ref(ref: str) -> None:
    if not ref or not _REF_RE.match(ref):
        raise HTTPException(400, "Invalid ID")


def _encode(data: str) -> str:
    return base64.urlsafe_b64encode(data.encode()).decode().rstrip("=")


def _decode(token: str) -> str:
    padding = "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(token + padding).decode()


def _make_file_ref(shared_url: str, path: str) -> str:
    return _encode(json.dumps({"u": shared_url, "p": path}))


def _parse_file_ref(ref: str) -> tuple[str, str]:
    data = json.loads(_decode(ref))
    return data["u"], data["p"]


async def _access_token() -> str:
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"] - 60:
        return _token_cache["token"]

    if DROPBOX_APP_KEY and DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN:
        async with httpx.AsyncClient(timeout=20) as client:
            res = await client.post(
                "https://api.dropbox.com/oauth2/token",
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": DROPBOX_REFRESH_TOKEN,
                    "client_id": DROPBOX_APP_KEY,
                    "client_secret": DROPBOX_APP_SECRET,
                },
            )
        if res.status_code != 200:
            raise HTTPException(502, "Failed to refresh Dropbox access token")
        data = res.json()
        _token_cache["token"] = data["access_token"]
        _token_cache["expires_at"] = now + data.get("expires_in", 14400)
        return _token_cache["token"]

    if DROPBOX_ACCESS_TOKEN:
        return DROPBOX_ACCESS_TOKEN

    raise HTTPException(500, "Server is missing Dropbox credentials")


def _dbx_error(res: httpx.Response) -> str:
    try:
        return res.json().get("error_summary", "Dropbox API request failed")
    except ValueError:
        return "Dropbox API request failed"


async def _api_post(path: str, json_body: dict) -> dict:
    token = await _access_token()
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.post(
            f"https://api.dropboxapi.com/2/{path}",
            headers={"Authorization": f"Bearer {token}"},
            json=json_body,
        )
    if res.status_code != 200:
        raise HTTPException(res.status_code if res.status_code < 500 else 502, _dbx_error(res))
    return res.json()


async def _content_fetch(path: str, api_arg: dict) -> tuple[bytes, str]:
    token = await _access_token()
    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            f"https://content.dropboxapi.com/2/{path}",
            headers={"Authorization": f"Bearer {token}", "Dropbox-API-Arg": json.dumps(api_arg)},
        )
    if res.status_code != 200:
        raise HTTPException(res.status_code if res.status_code < 500 else 502, _dbx_error(res))
    return res.content, res.headers.get("content-type", "application/octet-stream")


async def _content_stream(path: str, api_arg: dict):
    token = await _access_token()
    async with httpx.AsyncClient(timeout=60) as client:
        async with client.stream(
            "POST",
            f"https://content.dropboxapi.com/2/{path}",
            headers={"Authorization": f"Bearer {token}", "Dropbox-API-Arg": json.dumps(api_arg)},
        ) as res:
            if res.status_code != 200:
                raise HTTPException(404, "File not found or link no longer public")
            async for chunk in res.aiter_bytes():
                yield chunk


def _to_exif_time(iso_time: str | None) -> str | None:
    if not iso_time:
        return None
    # Dropbox gives "YYYY-MM-DDTHH:MM:SSZ"; match Drive's EXIF-style
    # "YYYY:MM:DD HH:MM:SS" since the frontend parses that format.
    return iso_time.replace("-", ":", 2).rstrip("Z").replace("T", " ")


async def list_gallery(source_id: str) -> dict:
    shared_url = _decode(source_id)

    entries = []
    data = await _api_post("files/list_folder", {
        "path": "",
        "shared_link": {"url": shared_url},
        "include_media_info": True,
        "recursive": False,
    })
    entries.extend(data.get("entries", []))
    while data.get("has_more"):
        data = await _api_post("files/list_folder/continue", {"cursor": data["cursor"]})
        entries.extend(data.get("entries", []))

    files = []
    for entry in entries:
        if entry.get(".tag") != "file":
            continue
        name = entry.get("name", "")
        if not _IMAGE_EXT_RE.search(name):
            continue
        media = (entry.get("media_info") or {}).get("metadata") or {}
        dims = media.get("dimensions") or {}
        files.append({
            "id": _make_file_ref(shared_url, entry["path_lower"]),
            "name": name,
            "createdTime": entry.get("client_modified"),
            "modifiedTime": entry.get("server_modified"),
            "mimeType": "image/*",
            "imageMediaMetadata": {
                "width": dims.get("width"),
                "height": dims.get("height"),
                "time": _to_exif_time(media.get("time_taken")),
            } if dims else None,
        })

    folder_name = shared_url.rstrip("/").split("/")[-1].split("?")[0] or "Gallery"
    try:
        meta = await _api_post("sharing/get_shared_link_metadata", {"url": shared_url})
        folder_name = meta.get("name") or folder_name
    except HTTPException:
        pass

    return {"name": folder_name, "files": files}


async def _get_thumbnail(file_ref: str, size: str) -> tuple[bytes, str]:
    shared_url, path = _parse_file_ref(file_ref)
    return await _content_fetch("files/get_thumbnail_v2", {
        "resource": {".tag": "link", "url": shared_url, "path": path},
        "format": "jpeg",
        "size": size,
    })


async def get_thumb(file_ref: str) -> tuple[bytes, str]:
    return await _get_thumbnail(file_ref, "w640h480")


async def get_full(file_ref: str) -> tuple[bytes, str]:
    return await _get_thumbnail(file_ref, "w2048h1536")


async def stream_download(file_ref: str):
    shared_url, path = _parse_file_ref(file_ref)
    async for chunk in _content_stream("sharing/get_shared_link_file", {"url": shared_url, "path": path}):
        yield chunk
