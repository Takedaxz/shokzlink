from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.downloads import Job, download_filename
from backend.storage import DeviceService


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("STORY (feat. SURIYA MQT & YUNGTARR)", "STORY (feat. SURIYA MQT & YUNGTARR).mp3"),
        ("เพลงของเรา (Remix)", "เพลงของเรา (Remix).mp3"),
        ("Song: Live / Acoustic", "Song_ Live _ Acoustic.mp3"),
        ("../outside", "_outside.mp3"),
    ],
)
def test_display_title_to_safe_filename(title: str, expected: str) -> None:
    assert download_filename(title) == expected


@pytest.mark.parametrize("title", ["", "   ", "..."])
def test_empty_titles_are_rejected(title: str) -> None:
    with pytest.raises(HTTPException):
        download_filename(title)


def test_long_unicode_title_is_truncated_without_breaking_utf8() -> None:
    name = download_filename("เพลง" * 200)
    assert len(name.encode("utf-8")) <= 240
    assert name.endswith(".mp3")
    assert "�" not in name


def test_playlist_cannot_apply_one_title_to_multiple_songs(tmp_path: Path) -> None:
    app = create_app(tmp_path / "data", DeviceService(lambda _: {}))
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        response = client.post(
            "/api/downloads",
            json={"url": "https://www.youtube.com/playlist?list=PLexample", "title": "One song", "permitted": True},
        )
        assert response.status_code == 400
        assert not app.state.downloads.jobs


def test_api_passes_card_title_to_download_job(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = create_app(tmp_path / "data", DeviceService(lambda _: {}))
    expected = "STORY (feat. SURIYA MQT & YUNGTARR)"
    received: list[tuple[str, str | None]] = []

    def capture(url: str, title: str | None = None) -> Job:
        received.append((url, title))
        return Job("fixture", url, title=title)

    monkeypatch.setattr(app.state.downloads, "add", capture)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        response = client.post(
            "/api/downloads",
            json={"url": "https://youtu.be/6YS3ISse240", "title": expected, "permitted": True},
        )
    assert response.status_code == 200
    assert received == [("https://youtu.be/6YS3ISse240", expected)]
