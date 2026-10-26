"""Drive throttling behaviour. Run: python -m unittest discover tests"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("S3_ENDPOINT_URL", "http://localhost")

import httpx  # noqa: E402

import main  # noqa: E402
import providers.drive as drive  # noqa: E402

_RealClient = httpx.AsyncClient
_real_sleep = asyncio.sleep


def _error(status, reason, headers=None):
    return httpx.Response(status, headers=headers,
                          json={"error": {"errors": [{"reason": reason}], "message": reason}})


class FakeDrive:
    """Patches httpx so every Drive call goes to `responses` in order (the
    last one repeats), recording requests and the backoff sleeps."""

    def __init__(self, responses):
        self.responses, self.requests, self.sleeps = responses, [], []

    def handler(self, request):
        self.requests.append(request)
        return self.responses[min(len(self.requests), len(self.responses)) - 1]

    def __enter__(self):
        async def fake_sleep(seconds):
            self.sleeps.append(seconds)

        self._patches = [
            mock.patch.object(drive.httpx, "AsyncClient",
                              lambda **kw: _RealClient(transport=httpx.MockTransport(self.handler), **kw)),
            mock.patch.object(drive, "DRIVE_API_KEY", "test-key"),
            mock.patch.object(drive, "MIN_REQUEST_INTERVAL", 0),
            mock.patch.object(drive.asyncio, "sleep", fake_sleep),
            mock.patch.object(main.asyncio, "sleep", fake_sleep),
            mock.patch.object(drive.random, "random", lambda: 0),
        ]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()


async def _download(file_ref="abc1234567"):
    return b"".join([c async for c in drive.stream_download(file_ref)])


class DriveQuota(unittest.IsolatedAsyncioTestCase):
    async def test_transient_rate_limit_is_retried(self):
        ok = httpx.Response(200, content=b"photo")
        with FakeDrive([_error(403, "userRateLimitExceeded"), _error(429, "rateLimitExceeded"), ok]) as fake:
            self.assertEqual(await _download(), b"photo")
        self.assertEqual(len(fake.requests), 3)

    async def test_retry_after_is_honoured(self):
        ok = httpx.Response(200, content=b"photo")
        with FakeDrive([_error(429, "rateLimitExceeded", {"Retry-After": "3"}), ok]) as fake:
            await _download()
        self.assertEqual(fake.sleeps, [3.0])

    async def test_per_file_quota_is_not_retried(self):
        with FakeDrive([_error(403, "downloadQuotaExceeded")]) as fake:
            with self.assertRaises(main.HTTPException) as cm:
                await _download()
        self.assertEqual((cm.exception.status_code, len(fake.requests)), (503, 1))
        self.assertEqual(cm.exception.detail["code"], "LS-DRV-FILE")
        self.assertRegex(cm.exception.detail["ref"], r"^[0-9A-F]{6}$")

    async def test_missing_or_private_file_is_not_retried(self):
        for response in (_error(404, "notFound"), _error(403, "forbidden")):
            with FakeDrive([response]) as fake:
                with self.assertRaises(main.HTTPException) as cm:
                    await _download()
            self.assertEqual((cm.exception.status_code, len(fake.requests)), (404, 1))
            self.assertEqual(cm.exception.detail["code"], "LS-DRV-GONE")

    async def test_retries_do_not_stack_across_layers(self):
        # Regression: stream_download retried 3x and _fetch_bytes retried that
        # 3x again, so one throttled photo cost up to 9 Drive requests.
        with FakeDrive([_error(403, "userRateLimitExceeded")]) as fake:
            with self.assertRaises(main.HTTPException) as cm:
                await main._fetch_bytes(drive, "abc1234567")
        self.assertEqual((cm.exception.status_code, len(fake.requests)), (503, 3))
        self.assertEqual(cm.exception.detail["code"], "LS-DRV-RATE")

    async def test_error_ref_is_logged_for_support(self):
        with FakeDrive([_error(403, "userRateLimitExceeded")]):
            with self.assertLogs("luxsync.errors", "WARNING") as logs:
                with self.assertRaises(main.HTTPException) as cm:
                    await _download()
        line = " ".join(logs.output)
        self.assertIn(cm.exception.detail["ref"], line)
        self.assertIn("reason=userRateLimitExceeded", line)

    async def test_mid_transfer_cut_is_still_retried(self):
        class Cut(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b"half"
                raise httpx.ReadError("cut off")

        cut = httpx.Response(200, stream=Cut())
        ok = httpx.Response(200, content=b"whole")
        with FakeDrive([cut, ok]) as fake:
            self.assertEqual(await main._fetch_bytes(drive, "abc1234567"), b"whole")
        self.assertEqual(len(fake.requests), 2)

    async def test_requests_are_paced(self):
        ok = httpx.Response(200, content=b"x")
        with FakeDrive([ok]):
            with mock.patch.object(drive, "MIN_REQUEST_INTERVAL", 0.05), \
                    mock.patch.object(drive.asyncio, "sleep", _real_sleep):
                drive._last_request = 0.0
                start = time.monotonic()
                for _ in range(4):
                    await _download()
                elapsed = time.monotonic() - start
        self.assertGreaterEqual(elapsed, 0.14)  # 3 gaps of 50ms between 4 starts

    async def test_thumbnail_429_is_retried_then_503(self):
        with FakeDrive([httpx.Response(429)]) as fake:
            with self.assertRaises(main.HTTPException) as cm:
                await drive.get_thumb("abc1234567")
        self.assertEqual((cm.exception.status_code, len(fake.requests)), (503, 3))


if __name__ == "__main__":
    unittest.main()
