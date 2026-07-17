"""S3-compatible object storage cache (Cloudflare R2 / Backblaze B2 both work).

Configured entirely via env vars (S3_ENDPOINT_URL, S3_BUCKET,
S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION). If S3_BUCKET is unset,
every call is a no-op miss/discard so the app still runs (just without
persistent caching) — useful for local dev without a bucket configured.
"""

import json
import os
import sys
import time
import traceback

import boto3
from botocore.config import Config


def _log(msg: str, exc: bool = False) -> None:
    # Plain print to stdout instead of the logging module — uvicorn's own
    # logging setup can swallow messages from other loggers depending on
    # config, and this needs to be unmissable in the Zeabur log stream.
    print(f"[cache] {msg}", file=sys.stdout, flush=True)
    if exc:
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()


BUCKET = os.environ.get("S3_BUCKET", "")

_client = None


def _s3():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=os.environ.get("S3_ENDPOINT_URL"),
            aws_access_key_id=os.environ.get("S3_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY"),
            region_name=os.environ.get("S3_REGION", "auto"),
            config=Config(signature_version="s3v4"),
        )
    return _client


def get_json(key: str, max_age_seconds: float):
    if not BUCKET:
        return None
    try:
        obj = _s3().get_object(Bucket=BUCKET, Key=key)
        wrapper = json.loads(obj["Body"].read())
    except Exception as e:
        _log(f"get_json miss/error for key={key}: {e!r}")
        return None
    if time.time() - wrapper.get("_cachedAt", 0) > max_age_seconds:
        return None
    return wrapper.get("data")


def put_json(key: str, data) -> bool:
    """Returns True on success. Never raises — a cache write failure should
    not take down the request that already has the data to return."""
    if not BUCKET:
        _log(f"put_json SKIPPED for key={key}: S3_BUCKET is not set")
        return False
    try:
        payload = json.dumps({"_cachedAt": time.time(), "data": data}).encode("utf-8")
        _s3().put_object(Bucket=BUCKET, Key=key, Body=payload, ContentType="application/json")
        _log(f"put_json OK for key={key} bucket={BUCKET}")
        return True
    except Exception as e:
        _log(f"put_json FAILED for key={key} bucket={BUCKET}: {e!r} (check S3_* env vars)", exc=True)
        return False


def exists(key: str) -> bool:
    if not BUCKET:
        return False
    try:
        _s3().head_object(Bucket=BUCKET, Key=key)
        _log(f"exists=True for key={key}")
        return True
    except Exception as e:
        _log(f"exists=False for key={key}: {e!r}")
        return False


def get_bytes(key: str):
    if not BUCKET:
        return None
    try:
        obj = _s3().get_object(Bucket=BUCKET, Key=key)
        return obj["Body"].read(), obj.get("ContentType", "application/octet-stream")
    except Exception as e:
        _log(f"get_bytes miss/error for key={key}: {e!r}")
        return None


def put_bytes(key: str, data: bytes, content_type: str) -> bool:
    """Returns True on success. Never raises — see put_json."""
    if not BUCKET:
        _log(f"put_bytes SKIPPED for key={key}: S3_BUCKET is not set")
        return False
    try:
        _s3().put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=content_type)
        _log(f"put_bytes OK for key={key} bucket={BUCKET} ({len(data)} bytes)")
        return True
    except Exception as e:
        _log(f"put_bytes FAILED for key={key} bucket={BUCKET}: {e!r} (check S3_* env vars)", exc=True)
        return False
