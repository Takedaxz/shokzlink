"""Explicit upstream-boundary fixtures; these do not claim live OAuth success."""

import asyncio
import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from ytmusicapi.auth.oauth import OAuthToken

from backend.app import create_app
from backend.downloads import Downloads, Job
from backend.music import Music, private_json
from backend.storage import DeviceService, Storage


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path / "data", DeviceService(lambda _: {}))
    with TestClient(app, base_url="http://127.0.0.1:8765") as value:
        yield value, app


def test_missing_auth_and_bad_playlist(client):
    http, _ = client
    assert http.post("/api/auth/start").status_code == 409
    assert http.get("/api/auth/poll/missing").status_code == 404
    assert http.get("/api/music/playlists/invalid!").status_code == 400
    assert http.get("/api/music/playlists/LM").status_code == 401
    assert http.post("/api/downloads/missing/cancel").status_code == 404


def test_public_search_bounded_and_sanitized(client, monkeypatch):
    http, _ = client

    class UpstreamFixture:
        def __init__(self, **kwargs):
            pass

        def search(self, query, filter, limit):
            assert query == "test song" and filter == "songs" and limit == 20
            return [{"videoId": "abcdefghijk", "title": "Song"}] * 30

    monkeypatch.setattr("backend.music.YTMusic", UpstreamFixture)
    response = http.get("/api/youtube/search", params={"q": " test song "})
    assert response.status_code == 200 and len(response.json()["videos"]) == 20

    class BrokenFixture:
        def __init__(self, **kwargs):
            raise RuntimeError("PRIVATE_TOKEN_FROM_UPSTREAM")

    monkeypatch.setattr("backend.music.YTMusic", BrokenFixture)
    response = http.get("/api/youtube/search", params={"q": "query"})
    assert response.status_code == 502
    assert "PRIVATE_TOKEN_FROM_UPSTREAM" not in response.text


def test_personal_playlists_likes_and_auth_constructor_errors(client, monkeypatch):
    http, app = client
    music = app.state.music
    music.configure("test.apps.googleusercontent.com", "secret")
    private_json(music.token_path, {"refresh_token": "private-refresh"})

    class MusicFixture:
        def __init__(self, *args, **kwargs):
            assert kwargs["oauth_credentials"].client_id == "test.apps.googleusercontent.com"

        def get_library_playlists(self, limit):
            assert limit == 100
            return [{"playlistId": "PLtest", "title": "My playlist", "count": 2}]

        def get_liked_songs(self, limit):
            assert limit == 500
            return {"tracks": [{"videoId": "abcdefghijk", "title": "Liked song"}]}

        def get_playlist(self, identifier, limit):
            assert identifier == "PLtest" and limit == 500
            return {"tracks": [{"videoId": "abcdefghijk", "title": "Playlist song"}]}

    monkeypatch.setattr("backend.music.YTMusic", MusicFixture)
    assert [p["id"] for p in http.get("/api/music/playlists").json()["playlists"]] == ["LM", "PLtest"]
    assert http.get("/api/music/playlists/LM").json()["videos"][0]["title"] == "Liked song"
    assert http.get("/api/music/playlists/PLtest").json()["videos"][0]["title"] == "Playlist song"

    class BrokenFixture:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("PRIVATE_TOKEN_FROM_UPSTREAM")

    monkeypatch.setattr("backend.music.YTMusic", BrokenFixture)
    response = http.get("/api/music/playlists")
    assert response.status_code == 401 and "PRIVATE_TOKEN_FROM_UPSTREAM" not in response.text


def test_auth_endpoints_and_real_token_parser(client, monkeypatch):
    http, app = client
    assert (
        http.post(
            "/api/auth/config",
            json={"clientId": "test.apps.googleusercontent.com", "clientSecret": "test-secret"},
        ).status_code
        == 200
    )
    responses = [
        {
            "device_code": "private-device",
            "verification_url": "https://www.google.com/device",
            "user_code": "USER-CODE",
            "expires_in": 1800,
        },
        {"access_token": "test-access", "refresh_token": "test-refresh", "expires_in": 3600},
    ]

    async def request(url, data):
        return responses.pop(0)

    monkeypatch.setattr(app.state.music, "request", request)
    response = http.post("/api/auth/start")
    assert response.status_code == 200 and "private-device" not in response.text
    identifier = response.json()["id"]
    app.state.music.flows[identifier].next_poll = 0
    assert http.get("/api/auth/poll/" + identifier).json()["status"] == "authenticated"
    # Use the actual installed ytmusicapi parser to validate its full token schema.
    token = OAuthToken.from_json(app.state.music.token_path)
    assert not token.is_expiring and token.refresh_token == "test-refresh"
    assert "test-refresh" not in http.get("/api/status").text


def test_oauth_unexpected_verification_host(tmp_path, monkeypatch):
    async def run():
        music = Music(tmp_path)
        music.configure("test.apps.googleusercontent.com", "secret")

        async def request(url, data):
            return {
                "device_code": "secret",
                "verification_url": "https://evil.example/device",
                "user_code": "CODE",
                "expires_in": 1800,
            }

        monkeypatch.setattr(music, "request", request)
        with pytest.raises(HTTPException) as exc:
            await music.start()
        assert exc.value.status_code == 502 and not music.flows

    asyncio.run(run())


def test_download_queue_limits_and_finalization(tmp_path):
    async def run():
        store = Storage(tmp_path, DeviceService(lambda _: {}))
        downloads = Downloads(store, asyncio.Lock())
        for index in range(50):
            job = Job(str(index), "https://www.youtube.com/watch?v=abcdefghijk")
            downloads.jobs[job.id] = job
        with pytest.raises(HTTPException) as exc:
            downloads.add("https://youtu.be/abcdefghijk")
        assert exc.value.status_code == 429
        job.finalizing = True
        with pytest.raises(HTTPException) as exc:
            await downloads.cancel(job.id)
        assert exc.value.status_code == 409
        job.finalizing = False
        await downloads.cancel(job.id)
        assert job.status == "cancelled"

    asyncio.run(run())


def test_auth_symlink_rejected(client, tmp_path):
    http, app = client
    outside = tmp_path / "outside-secret.json"
    outside.write_text(json.dumps({"refresh_token": "outside-secret"}))
    app.state.music.token_path.symlink_to(outside)
    response = http.get("/api/status")
    assert response.status_code == 409
    assert "outside-secret" not in response.text
    assert json.loads(outside.read_text())["refresh_token"] == "outside-secret"
