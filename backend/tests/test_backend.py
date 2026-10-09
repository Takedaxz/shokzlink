import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app import create_app, serialized
from backend.downloads import Downloads, youtube_url
from backend.music import Music, private_json, videos
from backend.storage import FFMPEG, DeviceService, Storage, digest, exclusive_move


@pytest.fixture
def audio(tmp_path):
    path = tmp_path / "fixture.mp3"
    subprocess.run(
        [
            FFMPEG,
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.2",
            "-c:a",
            "libmp3lame",
            str(path),
        ],
        check=True,
    )
    return path.read_bytes()


@pytest.fixture
def setup(tmp_path):
    mount = tmp_path / "device"
    mount.mkdir()
    metadata = {
        "VolumeName": "SWIM PRO",
        "Internal": False,
        "BusProtocol": "USB",
        "FilesystemType": "msdos",
        "Content": "Windows_FAT_32",
        "MountPoint": str(mount),
        "DeviceIdentifier": "disk99s1",
        "VolumeUUID": "test-volume",
        "VolumeSize": 100000000,
        "FreeSpace": 100000000,
    }
    device = DeviceService(lambda _: metadata, mount)
    app = create_app(tmp_path / "data", device)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        yield client, app.state.storage, metadata, app


def upload(client, audio, name="song.mp3"):
    return client.post("/api/library/import", files=[("files", (name, audio, "audio/mpeg"))])


def test_library_lifecycle_and_trash(setup, audio):
    client, store, _, _ = setup
    assert client.get("/api/health").json() == {"ok": True}
    assert upload(client, audio).json() == {"imported": 1}
    status = client.get("/api/status").json()
    assert status["library"][0]["path"] == "song.mp3"
    assert status["dependencies"] == {"ffmpeg": True, "yt_dlp": True}
    assert status["auth"] == {"configured": False, "authenticated": False}
    assert client.post(
        "/api/files/rename", json={"scope": "library", "path": "song.mp3", "name": "renamed.mp3"}
    ).json() == {"ok": True}
    assert client.post(
        "/api/files/move", json={"scope": "library", "path": "renamed.mp3", "folder": "Artist/Album"}
    ).json() == {"ok": True}
    assert client.get("/api/status").json()["folders"] == ["Artist", "Artist/Album"]
    body = {"scope": "library", "paths": ["Artist/Album/renamed.mp3"], "confirm": True}
    assert client.post("/api/files/delete", json=body).json() == {"deleted": 1}
    assert not (store.library / "Artist/Album/renamed.mp3").exists()
    backup = list(store.trash.rglob("*.mp3"))
    assert len(backup) == 1 and backup[0].read_bytes() == audio


def test_stream_audio_file(setup, audio):
    client, _, _, _ = setup
    upload(client, audio, "stream_test.mp3")
    res = client.get("/api/files/stream?scope=library&path=stream_test.mp3")
    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/mpeg"
    assert res.content == audio
    assert client.get("/api/files/stream?scope=invalid&path=stream_test.mp3").status_code == 400
    assert client.get("/api/files/stream?scope=library&path=missing.mp3").status_code == 404


@pytest.mark.parametrize(
    "name",
    [
        "../bad.mp3",
        "/bad.mp3",
        ".hidden.mp3",
        "evil\\bad.mp3",
        "bad.wav",
        "System Volume Information",
        "colon:bad.mp3",
        "bad.mp3 ",
    ],
)
def test_import_names_rejected(setup, audio, name):
    client, store, _, _ = setup
    assert upload(client, audio, name).status_code == 400
    assert not list(store.library.iterdir())


def test_import_batch_invalid_collision_no_partial(setup, audio):
    client, store, _, _ = setup
    result = client.post(
        "/api/library/import", files=[("files", ("good.mp3", audio)), ("files", ("bad.mp3", b"not audio"))]
    )
    assert result.status_code == 400
    assert not list(store.library.iterdir())
    assert upload(client, audio).status_code == 200
    assert upload(client, audio, "SONG.mp3").status_code == 409
    assert (store.library / "song.mp3").read_bytes() == audio
    assert not list(store.staging.iterdir())


def test_wav_disguised_as_mp3_rejected(setup, tmp_path):
    client, _, _, _ = setup
    wav = tmp_path / "test.wav"
    subprocess.run(
        [FFMPEG, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", str(wav)],
        check=True,
    )
    assert upload(client, wav.read_bytes()).status_code == 400


@pytest.mark.parametrize(
    "folder",
    [
        "../escape",
        "/absolute",
        ".Trashes",
        "System Volume Information",
        "SYSTEM",
        "music/system",
        "valid/../../bad",
        "folder//bad",
        "folder/.",
    ],
)
def test_device_folder_protection(setup, audio, folder):
    client, store, _, _ = setup
    upload(client, audio)
    assert client.post("/api/transfer", json={"paths": ["song.mp3"], "folder": folder}).status_code == 400
    assert not list(store.devices.mount.iterdir())


def test_transfer_content_skip_collision_and_device_mutations(setup, audio):
    client, store, _, _ = setup
    upload(client, audio)
    body = {"paths": ["song.mp3"], "folder": "Music"}
    assert client.post("/api/transfer", json=body).json() == {"copied": 1, "skipped": 0}
    assert (store.devices.mount / "Music/song.mp3").read_bytes() == audio
    assert client.post("/api/transfer", json=body).json() == {"copied": 0, "skipped": 1}
    (store.devices.mount / "Music/song.mp3").write_bytes(b"different content")
    assert client.post("/api/transfer", json=body).status_code == 409
    assert (
        client.post(
            "/api/files/rename", json={"scope": "device", "path": "Music/song.mp3", "name": "new.mp3"}
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/files/move", json={"scope": "device", "path": "Music/new.mp3", "folder": "Moved"}
        ).status_code
        == 200
    )
    assert client.post(
        "/api/files/delete", json={"scope": "device", "paths": ["Moved/new.mp3"], "confirm": True}
    ).json() == {"deleted": 1}
    assert list(store.trash.rglob("new.mp3"))[0].read_bytes() == b"different content"


def test_prevalidate_entire_transfer_and_delete(setup, audio):
    client, store, _, _ = setup
    upload(client, audio)
    assert (
        client.post("/api/transfer", json={"paths": ["song.mp3", "missing.mp3"], "folder": ""}).status_code
        == 404
    )
    assert not list(store.devices.mount.iterdir())
    assert (
        client.post(
            "/api/files/delete",
            json={"scope": "library", "paths": ["song.mp3", "../bad.mp3"], "confirm": True},
        ).status_code
        == 400
    )
    assert (store.library / "song.mp3").exists()
    assert not list(store.trash.iterdir())


@pytest.mark.parametrize("confirm", [False, "true", 1, None])
def test_explicit_boolean_confirmation(setup, confirm):
    client, _, _, _ = setup
    assert (
        client.post(
            "/api/files/delete", json={"scope": "device", "paths": ["song.mp3"], "confirm": confirm}
        ).status_code
        == 422
    )


def test_download_without_permission_flag(setup):
    client, _, _, _ = setup
    response = client.post("/api/downloads", json={"url": "https://youtu.be/abcdefghijk"})
    assert response.status_code == 200
    assert response.json()["status"] == "queued"


def test_symlink_escape_and_scan(setup, audio, tmp_path):
    client, store, _, _ = setup
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "song.mp3").write_bytes(audio)
    (store.library / "linked").symlink_to(outside, target_is_directory=True)
    (store.library / "file.mp3").symlink_to(outside / "song.mp3")
    assert client.get("/api/status").json()["library"] == []
    for path in ["linked/song.mp3", "file.mp3"]:
        assert (
            client.post(
                "/api/files/rename", json={"scope": "library", "path": path, "name": "new.mp3"}
            ).status_code
            == 400
        )
    (store.devices.mount / "escape").symlink_to(outside, target_is_directory=True)
    upload(client, audio)
    assert client.post("/api/transfer", json={"paths": ["song.mp3"], "folder": "escape"}).status_code == 400
    assert (outside / "song.mp3").read_bytes() == audio


@pytest.mark.parametrize(
    "key,value",
    [
        ("Internal", True),
        ("BusProtocol", "SATA"),
        ("FilesystemType", "apfs"),
        ("Content", "Apple_APFS"),
        ("VolumeName", "OTHER"),
        ("DeviceIdentifier", "disk99;touch bad"),
        ("VolumeUUID", ""),
        ("MountPoint", "/other"),
    ],
)
def test_device_metadata_required(setup, key, value):
    client, _, metadata, _ = setup
    metadata[key] = value
    assert not client.get("/api/status").json()["device"]["connected"]
    assert client.post("/api/device/eject").status_code == 409


def test_low_space_and_disconnection(setup, audio, monkeypatch):
    client, store, metadata, _ = setup
    upload(client, audio)
    metadata["FreeSpace"] = 0
    assert client.post("/api/transfer", json={"paths": ["song.mp3"], "folder": ""}).status_code == 409
    assert not list(store.devices.mount.iterdir())
    metadata["FreeSpace"] = 100000000
    original_check = store.check
    calls = 0

    def disconnect(device):
        nonlocal calls
        calls += 1
        if calls == 3:
            metadata["VolumeUUID"] = "replacement-disk"
        original_check(device)

    monkeypatch.setattr(store, "check", disconnect)
    assert client.post("/api/transfer", json={"paths": ["song.mp3"], "folder": ""}).status_code == 409
    assert not list(store.devices.mount.iterdir())


def test_exclusive_finalization_and_rename_collision(setup, audio, tmp_path):
    client, store, _, _ = setup
    upload(client, audio)
    upload(client, audio, "second.mp3")
    assert (
        client.post(
            "/api/files/rename", json={"scope": "library", "path": "song.mp3", "name": "second.mp3"}
        ).status_code
        == 409
    )
    a, b = tmp_path / "a", tmp_path / "b"
    a.write_bytes(b"first")
    b.write_bytes(b"second")
    with pytest.raises(HTTPException):
        exclusive_move(a, b)
    assert a.read_bytes() == b"first" and b.read_bytes() == b"second"
    assert digest(store.library / "song.mp3") == digest(store.library / "second.mp3")


def test_exclusive_move_enotsup_fallback(tmp_path, monkeypatch):
    import ctypes
    import errno

    a, b, c = tmp_path / "a", tmp_path / "b", tmp_path / "c"
    a.write_bytes(b"first")
    b.write_bytes(b"second")

    class MockRename:
        argtypes = None
        restype = None

        def __call__(self, *args):
            ctypes.set_errno(errno.ENOTSUP)
            return -1

    class DummyLib:
        renamex_np = MockRename()

    monkeypatch.setattr(ctypes, "CDLL", lambda *args, **kwargs: DummyLib())

    with pytest.raises(HTTPException) as exc_info:
        exclusive_move(a, b)
    assert exc_info.value.status_code == 409
    assert a.read_bytes() == b"first" and b.read_bytes() == b"second"

    exclusive_move(a, c)
    assert not a.exists()
    assert c.read_bytes() == b"first"


@pytest.mark.parametrize(
    "host,origin",
    [
        ("evil.example:8765", None),
        ("127.0.0.1.evil:8765", None),
        ("127.0.0.1:8765", "https://evil.example"),
        ("127.0.0.1:8765", "null"),
        ("127.0.0.1:8765", "http://localhost:9999"),
    ],
)
def test_dns_rebinding_and_origin(setup, host, origin):
    client, _, _, _ = setup
    headers = {"Host": host}
    if origin:
        headers["Origin"] = origin
    assert client.get("/api/status", headers=headers).status_code == 403
    assert client.post("/api/auth/logout", headers=headers).status_code == 403


def test_dev_origin_and_json_errors(setup):
    client, _, _, _ = setup
    response = client.get("/api/status", headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
    assert client.get("/api/status", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    response = client.post("/api/auth/config", json={"clientId": "a", "clientSecret": "SECRET", "extra": 1})
    assert response.status_code == 422 and isinstance(response.json()["detail"], str)
    assert "SECRET" not in response.text
    assert client.get("/api/not-a-route").status_code == 404


@pytest.mark.parametrize(
    "url",
    [
        "http://youtube.com/watch?v=abcdefghijk",
        "https://evil.com/watch?v=abcdefghijk",
        "https://youtube.com.evil/watch?v=abcdefghijk",
        "https://youtube.com@evil.com/a",
        "https://user@youtube.com/watch?v=abcdefghijk",
        "https://youtube.com:444/watch?v=abcdefghijk",
        "https://youtube.com/redirect?q=https://evil.com",
        "file:///etc/passwd",
        "https://youtu.be/../../bad",
        "https://youtube.com/watch?v=bad",
    ],
)
def test_download_url_restrictions(url):
    with pytest.raises(HTTPException):
        youtube_url(url)


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://youtu.be/abcdefghijk?si=foo", "https://www.youtube.com/watch?v=abcdefghijk"),
        (
            "https://music.youtube.com/watch?v=abcdefghijk&list=PLtest",
            "https://www.youtube.com/watch?v=abcdefghijk",
        ),
        ("https://www.youtube.com/playlist?list=PLtest", "https://www.youtube.com/playlist?list=PLtest"),
        ("https://youtube.com/shorts/abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk"),
    ],
)
def test_download_urls_canonicalized(url, expected):
    assert youtube_url(url) == expected


def test_oauth_private_config_and_logout(setup):
    client, store, _, _ = setup
    config = {"clientId": "test.apps.googleusercontent.com", "clientSecret": "secret-test-value"}
    assert client.post("/api/auth/config", json=config).json() == {"configured": True}
    path = store.data / "oauth-client.json"
    assert path.stat().st_mode & 0o777 == 0o600
    assert "secret-test-value" not in client.get("/api/status").text
    private_json(
        store.data / "oauth.json", {"refresh_token": "private-refresh", "access_token": "private-access"}
    )
    assert client.get("/api/status").json()["auth"]["authenticated"]
    assert client.post("/api/auth/logout").json() == {"ok": True}
    assert not (store.data / "oauth.json").exists()
    assert client.get("/api/status").json()["auth"] == {"configured": True, "authenticated": False}
    assert client.get("/api/music/playlists").status_code == 401


def test_oauth_interval_slowdown_and_expiry(tmp_path, monkeypatch):
    async def run():
        music = Music(tmp_path)
        music.configure("test.apps.googleusercontent.com", "secret")
        responses = [
            {
                "device_code": "DEVICE_SECRET",
                "verification_url": "https://www.google.com/device",
                "user_code": "USER-CODE",
                "expires_in": 1800,
                "interval": 5,
            },
            {"error": "authorization_pending"},
            {"error": "slow_down"},
            {"access_token": "ACCESS_SECRET", "refresh_token": "REFRESH_SECRET", "expires_in": 3600},
        ]
        requests = []

        async def request(url, data):
            requests.append((url, data))
            return responses.pop(0)

        monkeypatch.setattr(music, "request", request)
        started = await music.start()
        assert "DEVICE_SECRET" not in json.dumps(started)
        identifier = started["id"]
        flow = music.flows[identifier]
        assert (await music.poll(identifier))["status"] == "pending"
        assert len(requests) == 1
        flow.next_poll = 0
        assert (await music.poll(identifier))["status"] == "pending"
        flow.next_poll = 0
        assert (await music.poll(identifier))["status"] == "pending"
        assert flow.interval == 10 and flow.next_poll >= time.time() + 9
        flow.next_poll = 0
        assert (await music.poll(identifier))["status"] == "authenticated"
        token = json.loads(music.token_path.read_text())
        assert token["expires_at"] >= int(time.time()) + 3599
        assert music.token_path.stat().st_mode & 0o777 == 0o600
        assert requests[-1][1]["device_code"] == "DEVICE_SECRET"
        assert "SECRET" not in json.dumps(await music.poll(identifier))
        flow.status, flow.expires = "pending", 0
        assert (await music.poll(identifier))["status"] == "expired"

    asyncio.run(run())


@pytest.mark.parametrize(
    "error,status", [("access_denied", "denied"), ("expired_token", "expired"), ("invalid_client", "failed")]
)
def test_oauth_terminal_errors(tmp_path, monkeypatch, error, status):
    async def run():
        from backend.music import Flow

        music = Music(tmp_path)
        music.configure("test.apps.googleusercontent.com", "secret")
        music.flows["id"] = Flow("secret-device", time.time() + 1000, 5, 0)

        async def request(url, data):
            return {"error": error, "error_description": "private-token"}

        monkeypatch.setattr(music, "request", request)
        result = await music.poll("id")
        assert result["status"] == status and "private-token" not in json.dumps(result)

    asyncio.run(run())


def test_video_normalization():
    result = videos(
        [
            {
                "videoId": "abcdefghijk",
                "title": "Title",
                "artists": [{"name": "Artist"}],
                "thumbnails": [{"url": "https://example.org/image"}],
                "duration": "3:00",
            },
            {"videoId": None},
        ]
    )
    assert result == [
        {
            "id": "abcdefghijk",
            "title": "Title",
            "artist": "Artist",
            "thumbnail": "https://example.org/image",
            "duration": "3:00",
            "url": "https://www.youtube.com/watch?v=abcdefghijk",
        }
    ]


@pytest.mark.parametrize("title", [None, "STORY (feat. SURIYA MQT & YUNGTARR)", "เพลงของเรา (Remix)"])
def test_download_success_failure_and_cancel(tmp_path, audio, monkeypatch, title):
    async def run():
        store = Storage(tmp_path / "data", DeviceService(lambda _: {}))
        downloader = Downloads(store, asyncio.Lock())
        fixture = tmp_path / "fixture.mp3"
        fixture.write_bytes(audio)
        real_exec = asyncio.create_subprocess_exec
        mode = "success"

        async def fixture_process(*args, **kwargs):
            # Explicit test substitute for external downloader; use real OS processes.
            assert "--no-restrict-filenames" in args and "--restrict-filenames" not in args
            output = Path(args[args.index("-o") + 1]).parent / "fixture [abcdefghijk].mp3"
            if mode == "success":
                script = f"import shutil; shutil.copyfile({str(fixture)!r}, {str(output)!r}); print('SHOKZPROGRESS 100%')"
            elif mode == "failure":
                script = "import sys; sys.exit(1)"
            else:
                script = "import time; print('SHOKZPROGRESS 12%', flush=True); time.sleep(60)"
            return await real_exec(sys.executable, "-c", script, **kwargs)

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fixture_process)
        job = downloader.add("https://youtu.be/abcdefghijk", title)
        await job.task
        assert job.status == "completed" and job.progress == 100
        output = store.library / ((title or "fixture") + ".mp3")
        assert output.read_bytes() == audio
        duplicate = downloader.add("https://youtu.be/abcdefghijk", title)
        await duplicate.task
        assert duplicate.status == "failed"
        assert output.read_bytes() == audio
        mode = "failure"
        failed = downloader.add("https://youtu.be/abcdefghijk")
        await failed.task
        assert failed.status == "failed" and "bypassed" in failed.message
        mode = "cancel"
        cancelled = downloader.add("https://youtu.be/abcdefghijk")
        for _ in range(100):
            if cancelled.progress > 0:
                break
            await asyncio.sleep(0.01)
        assert cancelled.progress == 12
        await downloader.cancel(cancelled.id)
        assert cancelled.status == "cancelled" and cancelled.process.returncode is not None
        assert not list(store.staging.iterdir())

    asyncio.run(run())


def test_serialized_worker_keeps_lock_until_done():
    async def run():
        lock = asyncio.Lock()
        events = []

        def slow():
            events.append("first-start")
            time.sleep(0.05)
            events.append("first-end")

        task = asyncio.create_task(serialized(lock, slow))
        await asyncio.sleep(0.01)
        task.cancel()
        other = asyncio.create_task(serialized(lock, lambda: events.append("second")))
        with pytest.raises(asyncio.CancelledError):
            await task
        await other
        assert events == ["first-start", "first-end", "second"]

    asyncio.run(run())


def test_folder_creation_deletion_and_batch_move(setup, audio):
    client, store, _, _ = setup
    upload(client, audio, "song1.mp3")
    upload(client, audio, "song2.mp3")

    # Create folder and subfolder
    assert client.post("/api/folders/create", json={"scope": "library", "folder": "Workouts"}).status_code == 200
    assert client.post("/api/folders/create", json={"scope": "library", "folder": "Workouts/Running"}).status_code == 200
    assert "Workouts" in client.get("/api/status").json()["folders"]
    assert "Workouts/Running" in client.get("/api/status").json()["folders"]

    # Prevent duplicate folder
    assert client.post("/api/folders/create", json={"scope": "library", "folder": "Workouts"}).status_code == 409

    # Batch move files into folder
    move_res = client.post(
        "/api/files/move",
        json={"scope": "library", "paths": ["song1.mp3", "song2.mp3"], "folder": "Workouts/Running"},
    )
    assert move_res.status_code == 200
    status = client.get("/api/status").json()
    paths = [t["path"] for t in status["library"]]
    assert "Workouts/Running/song1.mp3" in paths
    assert "Workouts/Running/song2.mp3" in paths

    # Delete non-empty folder fails
    assert client.post("/api/folders/delete", json={"scope": "library", "folder": "Workouts/Running"}).status_code == 400

    # Move files back to root
    assert client.post(
        "/api/files/move",
        json={"scope": "library", "paths": ["Workouts/Running/song1.mp3", "Workouts/Running/song2.mp3"], "folder": ""},
    ).status_code == 200

    # Delete empty subfolder succeeds
    assert client.post("/api/folders/delete", json={"scope": "library", "folder": "Workouts/Running"}).status_code == 200
    assert "Workouts/Running" not in client.get("/api/status").json()["folders"]

