-- D1 (SQLite) schema for the download log. Same table the Python app kept in
-- data/luxsync.db. Safe to re-run.
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
