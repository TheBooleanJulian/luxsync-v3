"""Download-email logging and admin auth. Run: python -m unittest discover tests"""
import os
import sys
import tempfile
from contextlib import closing
import unittest

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


class DownloadTracking(unittest.TestCase):
    def setUp(self):
        main.limiter.enabled = False
        main.drive_provider.stream_download = _fake_stream
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

    def test_admin_requires_password(self):
        self.assertEqual(self.client.get("/api/admin/stats").status_code, 401)
        self.assertEqual(self.client.get("/api/admin/stats", auth=("a", "wrong")).status_code, 401)
        self.assertEqual(self.client.get("/api/admin/stats", auth=self.auth).status_code, 200)
        self.assertEqual(self.client.get("/admin", auth=self.auth).status_code, 200)

    def test_csv_export_neutralizes_formulas(self):
        downloads.log_download(email="=cmd@x.com", optin=False, provider="drive", source="S",
                               gallery_name="G", kind="photo", filenames=["a.jpg"])
        r = self.client.get("/api/admin/export.csv?view=emails", auth=self.auth)
        self.assertIn("'=cmd@x.com", r.text)


if __name__ == "__main__":
    unittest.main()
