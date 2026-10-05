"""Gallery source providers (Google Drive, Dropbox, ...).

Every provider module exposes the same functions so main.py can treat them
interchangeably:

    parse_source(url: str) -> str | None
        Recognize a pasted link and return an opaque source id, or None if
        this provider doesn't recognize the URL.

    validate_ref(ref: str) -> None
        Raise HTTPException(400) if `ref` (a source id or file ref returned
        by this provider) is malformed. Called on every incoming ref before
        it's used, since refs round-trip through the client.

    async list_gallery(source_id: str) -> dict
        Return {"name": str, "files": [...]}. Each file dict must include an
        "id" field (an opaque, provider-generated ref used for thumb/full/
        download calls) plus "name", "createdTime", "modifiedTime",
        "mimeType", and an EXIF-shaped "imageMediaMetadata" dict (or None).
        Video files are included too — "mimeType" starting with "video/"
        tells the frontend to show a play-icon overlay on the thumbnail and
        route clicks to download instead of the lightbox.

    async get_thumb(file_ref: str) -> tuple[bytes, str]
        Return (content_bytes, content_type) for a preview-sized image.
        Also called for video file refs — both Drive's and Dropbox's
        thumbnail endpoints generate a frame thumbnail for video files, no
        ffmpeg needed. The frontend falls back to a generic badge if this
        404s for an unsupported video codec/container.

    async get_full(file_ref: str) -> tuple[bytes, str]
        Return (content_bytes, content_type) for a full-size image. Not
        called for video files — the frontend downloads those directly
        instead of opening the lightbox.

    async stream_download(file_ref: str) -> AsyncIterator[bytes]
        Yield the original file's bytes in chunks.
"""
