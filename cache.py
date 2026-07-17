"""S3-compatible object storage cache (Cloudflare R2 / Backblaze B2 both work).

Configured entirely via env vars (S3_ENDPOINT_URL, S3_BUCKET,
S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION). If S3_BUCKET is unset,
every call is a no-op miss/discard so the app still runs (just without
persistent caching) — useful for local dev without a bucket configured.
"""

import json
import os
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

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
    except ClientError:
        return None
    if time.time() - wrapper.get("_cachedAt", 0) > max_age_seconds:
        return None
    return wrapper.get("data")


def put_json(key: str, data) -> None:
    if not BUCKET:
        return
    payload = json.dumps({"_cachedAt": time.time(), "data": data}).encode("utf-8")
    _s3().put_object(Bucket=BUCKET, Key=key, Body=payload, ContentType="application/json")


def exists(key: str) -> bool:
    if not BUCKET:
        return False
    try:
        _s3().head_object(Bucket=BUCKET, Key=key)
        return True
    except ClientError:
        return False


def get_bytes(key: str):
    if not BUCKET:
        return None
    try:
        obj = _s3().get_object(Bucket=BUCKET, Key=key)
        return obj["Body"].read(), obj.get("ContentType", "application/octet-stream")
    except ClientError:
        return None


def put_bytes(key: str, data: bytes, content_type: str) -> None:
    if not BUCKET:
        return
    _s3().put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=content_type)
