"""Upload a gallery's originals to the Worker's R2 mirror from a local copy.

For when Google's per-file download cap (LS-DRV-FILE) blocks a file: clients
can't download it and the background mirror can't copy it, but the Drive for
Desktop copy on this PC still reads fine. Once a file is in R2 the Worker serves
it from there and Drive's cap no longer matters.

    python tools/r2_push.py "K:/My Drive/#CLIENT_DELIVERABLES/2026/<gallery>" <drive folder id>
    python tools/r2_push.py <folder> <drive folder id> --dry-run

Local files are matched to the gallery by filename (the listing comes from
the live Worker) and uploaded to `drive/orig/<file id>`, the key the mirror
uses. Files already in R2 at the same size are skipped, so re-running is safe.

Credentials: an R2 S3 access key scoped to the luxsync-cache bucket, read from
the environment or from secrets/r2-s3.env (git-ignored):

    R2_ACCOUNT_ID=...
    R2_ACCESS_KEY_ID=...
    R2_SECRET_ACCESS_KEY=...

Standard library only. The secret is never printed.
"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

WORKER = "https://luxsync-v3.thebooleanjulian.dev"
BUCKET = "luxsync-cache"
PART = 64 * 1024 * 1024          # R2: all parts but the last must be the same size
SINGLE_PUT_MAX = PART            # smaller files go up in one request
ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "secrets", "r2-s3.env")


def load_creds():
    creds = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    creds[k.strip()] = v.strip().strip('"')
    for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        creds[k] = os.environ.get(k) or creds.get(k)
    missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY") if not creds.get(k)]
    if missing:
        sys.exit(f"Missing {', '.join(missing)}: set them in the environment or in {os.path.normpath(ENV_FILE)}")
    return creds


class R2:
    """Just enough S3 (SigV4, UNSIGNED-PAYLOAD) for HEAD, PUT and multipart."""

    def __init__(self, creds):
        self.host = f"{creds['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        self.key_id = creds["R2_ACCESS_KEY_ID"]
        self.secret = creds["R2_SECRET_ACCESS_KEY"]

    def _sign(self, method, path, query, headers, now=None, payload="UNSIGNED-PAYLOAD", region="auto"):
        now = now or datetime.datetime.now(datetime.timezone.utc)
        amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        headers = {**headers, "host": self.host, "x-amz-date": amz_date, "x-amz-content-sha256": payload}
        names = sorted(h.lower() for h in headers)
        lower = {k.lower(): str(v).strip() for k, v in headers.items()}
        canonical_query = "&".join(
            f"{urllib.parse.quote(k, safe='~')}={urllib.parse.quote(v, safe='~')}" for k, v in sorted(query.items())
        )
        canonical = "\n".join([
            method, path, canonical_query,
            "".join(f"{n}:{lower[n]}\n" for n in names), ";".join(names), payload,
        ])
        scope = f"{day}/{region}/s3/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        k = ("AWS4" + self.secret).encode()
        for part in (day, region, "s3", "aws4_request"):
            k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={self.key_id}/{scope}, SignedHeaders={';'.join(names)}, Signature={sig}"
        )
        del headers["host"]
        return headers, canonical_query

    def request(self, method, key, query=None, body=None, headers=None, attempts=4):
        path = "/" + urllib.parse.quote(f"{BUCKET}/{key}", safe="/~")
        for attempt in range(attempts):
            signed, qs = self._sign(method, path, query or {}, headers or {})
            url = f"https://{self.host}{path}" + (f"?{qs}" if qs else "")
            req = urllib.request.Request(url, data=body, method=method, headers=signed)
            try:
                with urllib.request.urlopen(req, timeout=300) as res:
                    return res.status, dict(res.headers), res.read()
            except urllib.error.HTTPError as e:
                if e.code == 404 and method == "HEAD":
                    return 404, {}, b""
                detail = e.read()[:300]
                if e.code < 500 and e.code != 429:
                    raise RuntimeError(f"{method} {key}: HTTP {e.code} {detail!r}") from None
                err = f"HTTP {e.code}"
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                err = str(e)
            if attempt == attempts - 1:
                raise RuntimeError(f"{method} {key}: {err} after {attempts} attempts")
            time.sleep(2 ** attempt)

    def size(self, key):
        status, headers, _ = self.request("HEAD", key)
        return int(headers.get("Content-Length", -1)) if status == 200 else None

    def upload(self, key, path, content_type, progress):
        total = os.path.getsize(path)
        if total <= SINGLE_PUT_MAX:
            with open(path, "rb") as f:
                self.request("PUT", key, body=f.read(), headers={"Content-Type": content_type})
            progress(total, total)
            return
        _, _, xml = self.request("POST", key, {"uploads": ""}, headers={"Content-Type": content_type})
        upload_id = ET.fromstring(xml).find("{*}UploadId").text
        try:
            etags = []
            with open(path, "rb") as f:
                for n, start in enumerate(range(0, total, PART), 1):
                    _, headers, _ = self.request("PUT", key, {"partNumber": str(n), "uploadId": upload_id}, body=f.read(PART))
                    etags.append(headers["ETag"])
                    progress(min(start + PART, total), total)
            done = "".join(f"<Part><PartNumber>{n}</PartNumber><ETag>{e}</ETag></Part>" for n, e in enumerate(etags, 1))
            self.request("POST", key, {"uploadId": upload_id},
                         body=f"<CompleteMultipartUpload>{done}</CompleteMultipartUpload>".encode())
        except BaseException:
            try:
                self.request("DELETE", key, {"uploadId": upload_id}, attempts=1)
            except Exception:
                pass  # an unfinished upload is cleaned up by R2's lifecycle anyway
            raise


def gallery_files(folder_id):
    req = urllib.request.Request(
        f"{WORKER}/api/gallery", method="POST",
        data=json.dumps({"provider": "drive", "source": folder_id}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "luxsync-r2-push"},
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.load(res)["files"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("folder", help="local copy of the gallery (e.g. the Drive for Desktop folder)")
    ap.add_argument("source", help="Drive folder id of the gallery")
    ap.add_argument("--dry-run", action="store_true", help="show what would be uploaded")
    args = ap.parse_args()

    local = {}
    for root, _, names in os.walk(args.folder):
        for name in names:
            local.setdefault(name, []).append(os.path.join(root, name))
    files = gallery_files(args.source)
    r2 = None if args.dry_run else R2(load_creds())

    plan, problems = [], []
    for f in files:
        paths = local.get(f["name"], [])
        if len(paths) != 1:
            problems.append(f"{f['name']}: {'not found locally' if not paths else 'several local files share this name'}")
            continue
        plan.append((f, paths[0]))
    print(f"{len(files)} files in gallery, {len(plan)} matched locally")
    for p in problems:
        print("  skip", p)

    failed = 0
    for f, path in plan:
        key = f"drive/orig/{f['id']}"
        size = os.path.getsize(path)
        label = f"{f['name']} ({size / 2**20:.0f} MiB)"
        if args.dry_run:
            print("  would upload", label)
            continue
        if r2.size(key) == size:
            print("  in R2 already", label)
            continue
        start = time.time()
        try:
            r2.upload(key, path, f.get("mimeType") or "application/octet-stream",
                      lambda done, total: print(f"\r  uploading {label}: {done * 100 // total}%", end="", flush=True))
            print(f"\r  uploaded {label} in {time.time() - start:.0f}s")
        except Exception as e:
            failed += 1
            print(f"\r  FAILED {label}: {e}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
