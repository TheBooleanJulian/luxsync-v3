"""Download-email logging and admin auth. Run: python -m unittest discover tests"""
import io
import os
import sys
import zipfile
import tempfile
from contextlib import closing
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_tmp = tempfile.mkdtemp()
os.environ["DATA_DIR"] = _tmp
os.environ["ADMIN_PASSWORD"] = "secret"
os.environ.setdefault("S3_ENDPOINT_URL", "http://localhost")

from fastapi.testclient import TestClient  # noqa: E402

import downloads  # noqa: E402
import main  # noqa: E402


async def _fake_stream(file_ref):
    yield b"data"


async def _no_sleep(_seconds):
    pass


class DownloadTracking(unittest.TestCase):
    def setUp(self):
        main.limiter.enabled = False
        # Self-cleaning, so later tests (and other test files) see the real
        # functions; tests below re-assign stream_download freely.
        for target, name, value in ((main.drive_provider, "stream_download", _fake_stream),
                                    (main.asyncio, "sleep", _no_sleep)):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = TestClient(main.app)
        self.auth = ("admin", "secret")
        with closing(downloads._connect()) as conn, conn:
            conn.execute("DELETE FROM downloads")

    def test_normalize_email(self):
        self.assertEqual(downloads.normalize_email(" Foo@Bar.COM "), "foo@bar.com")
        for bad in ("", "nope", "a@b", "a b@c.com", None):
            self.assertIsNone(downloads.normalize_email(bad))

    def test_single_download_requires_email(self):
        r = self.client.get("/api/download/drive/abc1234567?name=a.jpg")
        self.assertEqual(r.status_code, 400)
        r = self.client.get("/api/download/drive/abc1234567?name=a.jpg&email=bad")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(downloads.stats()["downloads"], 0)

    def test_single_and_zip_are_logged(self):
        r = self.client.get("/api/download/drive/abc1234567?name=a.jpg&email=Kai@x.com&optin=1&source=S1&gallery=Summit")
        self.assertEqual(r.status_code, 200)
        files = '[{"id":"abc1234567","name":"a.jpg"},{"id":"def4567890","name":"b.jpg"}]'
        r = self.client.post("/api/download-zip", data={
            "files": files, "email": "kai@x.com", "source": "S1", "gallery_name": "Summit",
            "kind": "all", "part": 0, "total": 450})
        self.assertEqual(r.status_code, 200)
        # second chunk of the same "Download All" must not log again
        self.client.post("/api/download-zip", data={
            "files": files, "email": "kai@x.com", "source": "S1", "gallery_name": "Summit",
            "kind": "all", "part": 1, "total": 450})

        self.assertEqual(downloads.list_downloads("photo")["total"], 1)
        gallery = downloads.list_downloads("gallery")
        self.assertEqual(gallery["total"], 1)
        self.assertEqual(gallery["items"][0]["file_count"], 450)
        emails = downloads.list_emails()
        self.assertEqual(len(emails), 1)
        self.assertEqual((emails[0]["email"], emails[0]["optin"], emails[0]["downloads"]), ("kai@x.com", 1, 2))

    def test_upstream_failure_is_an_error_not_an_empty_file(self):
        async def failing(file_ref):
            raise main.HTTPException(503, "busy")
            yield  # pragma: no cover
        main.drive_provider.stream_download = failing
        r = self.client.get("/api/download/drive/abc1234567?name=a.jpg&email=kai@x.com")
        self.assertEqual(r.status_code, 503)
        self.assertNotIn("attachment", r.headers.get("content-disposition", ""))

    def test_truncated_transfer_is_retried_and_sent_whole(self):
        calls = []

        async def flaky(file_ref):
            calls.append(1)
            yield b"half"
            if len(calls) < 3:
                raise main.httpx.ReadError("cut off")
            yield b"-rest"
        main.drive_provider.stream_download = flaky
        r = self.client.get("/api/download/drive/abc1234567?name=a.jpg&email=kai@x.com")
        self.assertEqual((r.status_code, r.content), (200, b"half-rest"))
        self.assertEqual(r.headers["content-length"], "9")

    def test_always_truncated_is_an_error_not_a_corrupt_file(self):
        async def broken(file_ref):
            yield b"half"
            raise main.httpx.ReadError("cut off")
        main.drive_provider.stream_download = broken
        r = self.client.get("/api/download/drive/abc1234567?name=a.jpg&email=kai@x.com")
        self.assertEqual(r.status_code, 503)

    def test_zip_progress_is_reported_per_file(self):
        files = '[{"id":"abc1234567","name":"a.jpg"},{"id":"def4567890","name":"b.jpg"}]'
        r = self.client.post("/api/download-zip", data={
            "files": files, "email": "kai@x.com", "job_id": "job1234567890abcd"})
        self.assertEqual(r.status_code, 200)
        r = self.client.get("/api/download-progress?jobs=job1234567890abcd,unknownjob123456")
        self.assertEqual(r.json(), {"job1234567890abcd": {"state": "done", "files": "dd", "bytes": 4, "fail": {}, "error": None}})

    def test_failed_photo_is_skipped_not_fatal_to_the_zip(self):
        # One unfetchable photo must not abort the zip (that left visitors with
        # an "invalid" zip): it is skipped, reported, and listed in the zip.
        async def one_missing(file_ref):
            if file_ref == "def4567890":
                raise main.LuxError(404, "LS-DRV-GONE", "test")
            yield b"photo-bytes"
        main.drive_provider.stream_download = one_missing
        files = '[{"id":"abc1234567","name":"a.jpg"},{"id":"def4567890","name":"b.jpg"},{"id":"ghi7890123","name":"c.jpg"}]'
        r = self.client.post("/api/download-zip", data={
            "files": files, "email": "kai@x.com", "job_id": "jobfail1234567890"})
        self.assertEqual(r.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            self.assertIsNone(z.testzip())
            self.assertEqual(z.namelist(), ["a.jpg", "c.jpg", "_MISSING_FILES.txt"])
            note = z.read("_MISSING_FILES.txt").decode()
        job = self.client.get("/api/download-progress?jobs=jobfail1234567890").json()["jobfail1234567890"]
        self.assertEqual((job["state"], job["files"], job["error"]), ("done", "dfd", None))
        self.assertEqual(job["fail"]["1"]["code"], "LS-DRV-GONE")
        self.assertIn(f"b.jpg  [LS-DRV-GONE ref {job['fail']['1']['ref']}]", note)

    def test_zip_name_not_doubled(self):
        self.assertEqual(main._sanitize_zip_name("Hatsunemelvin V6 Miku MBS.zip"), "Hatsunemelvin V6 Miku MBS")

    def test_non_ascii_names_do_not_500(self):
        # Curly apostrophe in the gallery/file name used to crash the header encode.
        name = "Julian’s Shoot — café"
        files = '[{"id":"abc1234567","name":"%s.jpg"},{"id":"def4567890","name":"b.jpg"}]' % name
        r = self.client.post("/api/download-zip", data={"files": files, "email": "kai@x.com", "zip_name": name})
        self.assertEqual(r.status_code, 200)
        self.assertIn("filename*=UTF-8''Julian%E2%80%99s", r.headers["content-disposition"])
        r = self.client.get("/api/download/drive/abc1234567", params={"name": name + ".jpg", "email": "kai@x.com"})
        self.assertEqual(r.status_code, 200)

    def test_admin_requires_password(self):
        self.assertEqual(self.client.get("/api/admin/stats").status_code, 401)
        self.assertEqual(self.client.get("/api/admin/stats", auth=("a", "wrong")).status_code, 401)
        self.assertEqual(self.client.get("/api/admin/stats", auth=self.auth).status_code, 200)
        self.assertEqual(self.client.get("/admin", auth=self.auth).status_code, 200)

    def test_admin_username_enforced_when_set(self):
        main.ADMIN_USERNAME = "julian"
        try:
            self.assertEqual(self.client.get("/api/admin/stats", auth=("other", "secret")).status_code, 401)
            self.assertEqual(self.client.get("/api/admin/stats", auth=("julian", "wrong")).status_code, 401)
            self.assertEqual(self.client.get("/api/admin/stats", auth=("julian", "secret")).status_code, 200)
        finally:
            main.ADMIN_USERNAME = ""

    def test_csv_export_neutralizes_formulas(self):
        downloads.log_download(email="=cmd@x.com", optin=False, provider="drive", source="S",
                               gallery_name="G", kind="photo", filenames=["a.jpg"])
        r = self.client.get("/api/admin/export.csv?view=emails", auth=self.auth)
        self.assertIn("'=cmd@x.com", r.text)


if __name__ == "__main__":
    unittest.main()
