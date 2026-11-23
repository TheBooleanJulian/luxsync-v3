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
     last_error TEXT, paused INTEGER NOT NULL DEFAULT 0, last_opened TEXT, expired_at TEXT,
     PRIMARY KEY (provider, source));
-- Added 2026-11-19 (v0.15.0). On a table created earlier, mirror.js adds them on first use:
--   ALTER TABLE mirror_galleries ADD COLUMN last_opened TEXT;
--   ALTER TABLE mirror_galleries ADD COLUMN expired_at TEXT;
CREATE TABLE IF NOT EXISTS mirror_files (
     provider TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL, done_at TEXT NOT NULL,
     PRIMARY KEY (provider, source, ref));
-- In-progress multipart copies of big originals (one row per file, deleted when done).
CREATE TABLE IF NOT EXISTS mirror_uploads (
     provider TEXT NOT NULL, ref TEXT NOT NULL, upload_id TEXT NOT NULL, size INTEGER NOT NULL,
     parts TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (provider, ref));

-- Error console for /admin (worker/src/errorlog.js, which also creates it on
-- first use). Server errors (origin 'server') plus the error reports visitors'
-- browsers were shown (origin 'client'). Pruned after ERROR_LOG_DAYS (30).
CREATE TABLE IF NOT EXISTS error_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, origin TEXT NOT NULL,
     code TEXT NOT NULL, ref TEXT, status INTEGER, path TEXT, gallery TEXT,
     context TEXT, report TEXT, ip_hash TEXT);
CREATE INDEX IF NOT EXISTS error_log_ts ON error_log (ts);
CREATE INDEX IF NOT EXISTS error_log_ref ON error_log (ref);
