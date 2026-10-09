import subprocess

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.storage import DeviceService, Storage, safe_path


def test_eject_readback_uses_only_validated_identifier(tmp_path, monkeypatch):
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
    calls = []

    def eject(command, **kwargs):
        calls.append(command)
        assert command == ["/usr/sbin/diskutil", "eject", "disk99s1"]
        metadata.clear()  # Explicit external-command fixture simulates unmounted metadata.
        return subprocess.CompletedProcess(command, 0, b"", b"")

    monkeypatch.setattr(subprocess, "run", eject)
    app = create_app(tmp_path / "data", device)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        assert client.post("/api/device/eject").json() == {"ok": True}
        assert not client.get("/api/status").json()["device"]["connected"]
        assert client.post("/api/device/eject").status_code == 409
    assert len(calls) == 1


def test_eject_success_exit_code_is_not_sufficient(tmp_path, monkeypatch):
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
    }
    service = DeviceService(lambda _: metadata, mount)
    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs: subprocess.CompletedProcess(command, 0))
    with pytest.raises(HTTPException) as exc:
        service.eject()
    assert exc.value.status_code == 409


def test_root_and_mount_symlinks_are_rejected(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(RuntimeError):
        Storage(link, DeviceService(lambda _: {}))
    with pytest.raises(HTTPException):
        safe_path(link, "song.mp3")
    metadata = {
        "VolumeName": "SWIM PRO",
        "Internal": False,
        "BusProtocol": "USB",
        "FilesystemType": "msdos",
        "Content": "Windows_FAT_32",
        "MountPoint": str(link),
        "DeviceIdentifier": "disk99s1",
        "VolumeUUID": "test-volume",
    }
    assert DeviceService(lambda _: metadata, link).detect() is None


def test_application_data_cannot_be_created_on_device(tmp_path):
    mount = tmp_path / "device"
    mount.mkdir()
    with pytest.raises(RuntimeError):
        Storage(mount / "app-data", DeviceService(lambda _: {}, mount))
    assert not list(mount.iterdir())
