"""Client-facing error codes for downloads.

Every failure a visitor can see carries a short code (LS-...), a plain-language
message and a random reference. The reference is logged server-side next to
the details, so a visitor's screenshot ("LS-DRV-RATE · ref 3FA91C") can be
matched to the exact log line in Zeabur.

Codes starting LS-JOB / LS-NET-OFF / LS-LIMIT are raised in the browser
(index.html) — keep the two lists in sync.
"""

import logging
import secrets

from fastapi import HTTPException

log = logging.getLogger("luxsync.errors")

MESSAGES = {
    "LS-DRV-RATE": "Google Drive is temporarily limiting requests. Wait a minute, then try again.",
    "LS-DRV-FILE": "Google has temporarily limited downloads of this file. Try again in a few hours.",
    "LS-DRV-GONE": "This file is missing or is no longer shared publicly.",
    "LS-DRV-CFG": "The server is not set up to talk to Google Drive.",
    "LS-NET-CUT": "The connection to the source dropped mid-download.",
    "LS-SRC-EMPTY": "The source returned an empty file.",
    "LS-ZIP-FAIL": "The zip was interrupted before it finished.",
}


class LuxError(HTTPException):
    """HTTPException whose detail is {"code", "message", "ref"}. Logs itself,
    with `context` (file id, status, Google's reason...), at creation."""

    def __init__(self, status_code: int, code: str, context: str = ""):
        ref = secrets.token_hex(3).upper()
        super().__init__(status_code, detail={"code": code, "message": MESSAGES[code], "ref": ref})
        log.warning("%s ref=%s status=%s %s", code, ref, status_code, context)


def describe(exc: BaseException, context: str = "") -> dict:
    """{"code", "message", "ref"} for any exception, logging the ones that
    weren't already a LuxError."""
    if isinstance(exc, LuxError):
        return exc.detail
    ref = secrets.token_hex(3).upper()
    if isinstance(exc, HTTPException):
        code, message = f"LS-HTTP-{exc.status_code}", str(exc.detail)
    else:
        code, message = "LS-ZIP-FAIL", MESSAGES["LS-ZIP-FAIL"]
    log.warning("%s ref=%s %s: %r", code, ref, context, exc)
    return {"code": code, "message": message, "ref": ref}
