"""Folder paths on listed files (folder view). Run: python -m unittest discover tests"""
import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import providers.drive as drive  # noqa: E402
from providers.dropbox_provider import _folder_of  # noqa: E402

FOLDER = drive.FOLDER_MIME


class DriveFolderPaths(unittest.TestCase):
    def test_files_carry_subfolder_path(self):
        tree = {
            "root": [
                {"id": "a", "name": "a.jpg", "mimeType": "image/jpeg"},
                {"id": "alice", "name": "Alice", "mimeType": FOLDER},
                {"id": "txt", "name": "notes.txt", "mimeType": "text/plain"},
            ],
            "alice": [
                {"id": "b", "name": "b.jpg", "mimeType": "image/jpeg"},
                {"id": "cer", "name": "Ceremony", "mimeType": FOLDER},
            ],
            "cer": [{"id": "c", "name": "c.mp4", "mimeType": "video/mp4"}],
        }

        async def fake_children(parent_id):
            return [dict(f) for f in tree[parent_id]]

        with mock.patch.object(drive, "_list_children", fake_children):
            media = asyncio.run(drive._collect_media("root"))
        self.assertEqual({f["id"]: f["folder"] for f in media},
                         {"a": [], "b": ["Alice"], "c": ["Alice", "Ceremony"]})


class DropboxFolderPaths(unittest.TestCase):
    def test_folder_of(self):
        self.assertEqual(_folder_of({"path_display": "/a.jpg"}), [])
        self.assertEqual(_folder_of({"path_display": "/Alice/Ceremony/c.jpg", "path_lower": "/alice/ceremony/c.jpg"}),
                         ["Alice", "Ceremony"])
        self.assertEqual(_folder_of({"path_lower": "/alice/b.jpg"}), ["alice"])
        self.assertEqual(_folder_of({}), [])


if __name__ == "__main__":
    unittest.main()
