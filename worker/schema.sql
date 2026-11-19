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

-- Background R2 mirroring (worker/src/mirror.js, which also creates these on
-- first use). One row per gallery opened in LuxSync; one per fully mirrored file.
CREATE TABLE IF NOT EXISTS mirror_galleries (
     provider TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
     added_at TEXT NOT NULL, next_check TEXT NOT NULL, last_run TEXT,
     files INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
     last_error TEXT, paused INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (provider, source));
CREATE TABLE IF NOT EXISTS mirror_files (
     provider TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL, done_at TEXT NOT NULL,
     PRIMARY KEY (provider, source, ref));
