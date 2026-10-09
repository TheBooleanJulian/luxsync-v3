"""Download-activity log — who (email) downloaded what, for the admin dashboard.

A single SQLite file at DATA_DIR/luxsync.db (default ./data). On Zeabur the
container disk is wiped on every redeploy, so mount a persistent volume at
DATA_DIR or the log resets each deploy.
"""

import hashlib
import json
import logging
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone

log = logging.getLogger("luxsync.downloads")

DATA_DIR = os.environ.get("DATA_DIR", "data")
DB_PATH = os.path.join(DATA_DIR, "luxsync.db")

# Salt for hashing visitor IPs so the log holds no raw IPs.
_IP_SALT = os.environ.get("IP_HASH_SALT") or os.environ.get("ADMIN_PASSWORD", "")

_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")

# kind: "photo" (single file), "selected" (zip of a selection), "all" (whole gallery zip)
KINDS = ("photo", "selected", "all")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS downloads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    email        TEXT NOT NULL,
    optin        INTEGER NOT NULL DEFAULT 0,
    provider     TEXT NOT NULL,
    source       TEXT NOT NULL,
    gallery_name TEXT NOT NULL,
    kind         TEXT NOT NULL,
    file_count   INTEGER NOT NULL,
    filenames    TEXT NOT NULL,
    ip_hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_downloads_ts ON downloads(ts);
CREATE INDEX IF NOT EXISTS idx_downloads_email ON downloads(email);
"""


def _connect() -> sqlite3.Connection:
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    return conn


def normalize_email(raw: str | None) -> str | None:
    """Lowercased email if it looks valid, else None."""
    email = (raw or "").strip().lower()
    if len(email) > 254 or not _EMAIL_RE.match(email):
        return None
    return email


def _hash_ip(ip: str) -> str:
    return hashlib.sha256(f"{_IP_SALT}:{ip}".encode()).hexdigest()[:16]


def log_download(*, email: str, optin: bool, provider: str, source: str,
                 gallery_name: str, kind: str, filenames: list[str],
                 file_count: int | None = None, ip: str = "") -> None:
    """Record one download. Never raises — a logging failure must not block the
    visitor's download."""
    try:
        with closing(_connect()) as conn, conn:
            conn.execute(
                "INSERT INTO downloads (ts, email, optin, provider, source, gallery_name,"
                " kind, file_count, filenames, ip_hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (datetime.now(timezone.utc).isoformat(timespec="seconds"), email,
                 int(optin), provider, source, gallery_name[:200], kind,
                 file_count if file_count is not None else len(filenames),
                 json.dumps(filenames[:500]), _hash_ip(ip)),
            )
    except Exception:
        log.exception("Failed to log download")


def stats() -> dict:
    with closing(_connect()) as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS downloads, COUNT(DISTINCT email) AS emails,"
            " COUNT(DISTINCT source) AS galleries FROM downloads").fetchone()
        optins = conn.execute(
            "SELECT COUNT(*) FROM (SELECT email FROM downloads GROUP BY email"
            " HAVING MAX(optin) = 1)").fetchone()[0]
    return {**dict(row), "optins": optins}


def list_downloads(view: str, q: str = "", limit: int = 100, offset: int = 0) -> dict:
    """view: 'gallery' (whole-gallery + selection zips) or 'photo' (single files)."""
    kinds = ("photo",) if view == "photo" else ("all", "selected")
    where = f"kind IN ({','.join('?' * len(kinds))})"
    params: list = list(kinds)
    if q:
        where += " AND (email LIKE ? OR gallery_name LIKE ? OR filenames LIKE ?)"
        params += [f"%{q}%"] * 3
    with closing(_connect()) as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM downloads WHERE {where}", params).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM downloads WHERE {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            params + [limit, offset]).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        d["filenames"] = json.loads(d["filenames"])
        del d["ip_hash"]
        items.append(d)
    return {"total": total, "items": items}


def list_emails(q: str = "") -> list[dict]:
    where, params = "", []
    if q:
        where, params = "WHERE email LIKE ?", [f"%{q}%"]
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT email, MAX(optin) AS optin, COUNT(*) AS downloads,"
            " COUNT(DISTINCT source) AS galleries, MIN(ts) AS first_seen, MAX(ts) AS last_seen"
            f" FROM downloads {where} GROUP BY email ORDER BY last_seen DESC", params).fetchall()
    return [dict(r) for r in rows]
