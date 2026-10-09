"""Filesystem operations; no device mutations occur until an explicit API request."""

from __future__ import annotations

import ctypes
import errno
import hashlib
import os
import plistlib
import re
import shutil
import subprocess
import sys
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import NoReturn

from fastapi import HTTPException

PROTECTED = {"system", "system volume information", "$recycle.bin", "recycler", "lost.dir", "lost+found"}
FFMPEG = shutil.which("ffmpeg") or str(Path.home() / ".hermes/tools/ffmpeg-9.0.1-darwin-arm64/ffmpeg")


def fail(message: str, status: int = 400) -> NoReturn:
    raise HTTPException(status, message)


def components(value: str, empty: bool = False) -> list[str]:
    if empty and value == "":
        return []
    if not value or "\\" in value or PurePosixPath(value).is_absolute():
        fail("Invalid relative path")
    parts = value.split("/")
    for part in parts:
        if (
            part in {"", ".", ".."}
            or part.startswith(".")
            or part.casefold() in PROTECTED
            or part.rstrip(" .") != part
            or len(part.encode("utf-8")) > 240
            or any(ord(c) < 32 or c in '<>:"|?*' for c in part)
        ):
            fail("Unsafe or protected path")
    return parts


def safe_path(root: Path, value: str, *, folder: bool = False) -> Path:
    parts = components(value, empty=folder)
    if any(p.is_symlink() for p in (root, *root.parents)) or not root.is_dir():
        fail("Storage root unavailable", 409)
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            fail("Symlinks are not allowed")
    if not current.resolve().is_relative_to(root.resolve()):
        fail("Path escapes storage root")
    return current


def mp3_name(name: str) -> str:
    parts = components(name)
    if len(parts) != 1 or Path(name).suffix.lower() != ".mp3":
        fail("A safe MP3 filename is required")
    return name


def selected(root: Path, paths: list[str]) -> list[Path]:
    if not paths or len(paths) > 500 or len(set(paths)) != len(paths):
        fail("Choose 1–500 distinct MP3 files")
    result = [safe_path(root, p) for p in paths]
    for p in result:
        if not p.is_file() or p.suffix.lower() != ".mp3":
            fail("Selected MP3 file not found", 404)
    return result


def collision(target: Path, exclude: Path | None = None) -> bool:
    if not target.parent.exists():
        return False
    return any(p.name.casefold() == target.name.casefold() and p != exclude for p in target.parent.iterdir())


def exclusive_move(source: Path, target: Path) -> None:
    """Atomic no-clobber finalization, falling back safely when RENAME_EXCL is unsupported (e.g. FAT32)."""
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(os.fsencode(source), os.fsencode(target), 0x00000004):  # RENAME_EXCL
            code = ctypes.get_errno()
            if code == errno.EEXIST:
                fail("Destination filename already exists", 409)
            if code in (errno.ENOTSUP, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)):
                if collision(target, exclude=source):
                    fail("Destination filename already exists", 409)
                os.replace(source, target)
                return
            raise OSError(code, "Exclusive rename failed")
    else:
        try:
            os.link(source, target)  # no-clobber on other development platforms
            source.unlink()
        except OSError as e:
            if e.errno == errno.EEXIST:
                fail("Destination filename already exists", 409)
            if e.errno in (errno.EPERM, errno.ENOTSUP, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP), errno.EXDEV):
                if collision(target, exclude=source):
                    fail("Destination filename already exists", 409)
                os.replace(source, target)
            else:
                raise


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def valid_audio(path: Path) -> None:
    if not Path(FFMPEG).is_file():
        fail("ffmpeg is required for audio validation", 503)
    # Decode the entire audio, not just a header; reject corrupt or non-MP3 input.
    probe = str(Path(FFMPEG).with_name("ffprobe"))
    if Path(probe).is_file():
        result = subprocess.run(
            [
                probe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=nw=1:nk=1",
                str(path),
            ],
            capture_output=True,
            timeout=30,
        )
        if result.returncode or result.stdout.strip() != b"mp3":
            fail("File is not valid MP3 audio")
    result = subprocess.run(
        [
            FFMPEG,
            "-nostdin",
            "-v",
            "error",
            "-xerror",
            "-f",
            "mp3",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        timeout=180,
    )
    if result.returncode or path.stat().st_size == 0:
        fail("File is not valid MP3 audio")


def inventory(root: Path) -> tuple[list[dict[str, object]], list[str]]:
    tracks: list[dict[str, object]] = []
    folders: list[str] = []
    if not root.is_dir() or any(p.is_symlink() for p in (root, *root.parents)):
        return tracks, folders
    for base, dirs, files in os.walk(root, followlinks=False):
        parent = Path(base)
        dirs[:] = sorted(
            d
            for d in dirs
            if not d.startswith(".") and d.casefold() not in PROTECTED and not (parent / d).is_symlink()
        )
        for d in dirs:
            folders.append((parent / d).relative_to(root).as_posix())
        for name in sorted(files):
            p = parent / name
            if name.startswith(".") or p.is_symlink() or p.suffix.lower() != ".mp3":
                continue
            try:
                stat = p.stat()
                tracks.append(
                    {
                        "path": p.relative_to(root).as_posix(),
                        "name": p.name,
                        "title": p.stem,
                        "size": stat.st_size,
                        "modified": stat.st_mtime,
                    }
                )
            except OSError:
                continue
    return sorted(tracks, key=lambda t: str(t["path"]).casefold()), sorted(folders)


@dataclass(frozen=True)
class Device:
    root: Path
    identifier: str
    uuid: str
    total: int
    free: int


class DeviceService:
    def __init__(
        self,
        metadata: Callable[[Path], dict[str, object]] | None = None,
        mount: Path = Path("/Volumes/SWIM PRO"),
    ):
        self.metadata = metadata or self.disk_info
        self.mount = mount

    @staticmethod
    def disk_info(mount: Path) -> dict[str, object]:
        result = subprocess.run(
            ["/usr/sbin/diskutil", "info", "-plist", str(mount)], capture_output=True, timeout=10
        )
        if result.returncode:
            return {}
        info = plistlib.loads(result.stdout)
        return info if isinstance(info, dict) else {}

    def detect(self) -> Device | None:
        try:
            info = self.metadata(self.mount)
            identifier = str(info.get("DeviceIdentifier", ""))
            if (
                info.get("VolumeName") != "SWIM PRO"
                or info.get("Internal") is not False
                or info.get("BusProtocol") != "USB"
                or info.get("FilesystemType") != "msdos"
                or info.get("Content") != "Windows_FAT_32"
                or info.get("MountPoint") != str(self.mount)
                or not re.fullmatch(r"disk\d+s\d+", identifier)
                or not info.get("VolumeUUID")
                or self.mount.is_symlink()
                or not self.mount.is_dir()
            ):
                return None
            return Device(
                self.mount,
                identifier,
                str(info["VolumeUUID"]),
                int(info.get("VolumeSize", 0)),
                int(info.get("FreeSpace", 0)),
            )
        except (OSError, ValueError, TypeError, subprocess.SubprocessError, plistlib.InvalidFileException):
            return None

    def require(self, previous: Device | None = None) -> Device:
        device = self.detect()
        if device is None or (
            previous and (device.uuid, device.identifier) != (previous.uuid, previous.identifier)
        ):
            fail("SWIM PRO disconnected or changed", 409)
        return device

    def status(self) -> dict[str, object]:
        d = self.detect()
        tracks, folders = inventory(d.root) if d else ([], [])
        return {
            "connected": d is not None,
            "name": "SWIM PRO" if d else None,
            "mount": str(d.root) if d else None,
            "total": d.total if d else 0,
            "free": d.free if d else 0,
            "tracks": tracks,
            "folders": folders,
        }

    def eject(self) -> None:
        d = self.require()
        result = subprocess.run(
            ["/usr/sbin/diskutil", "eject", d.identifier], capture_output=True, timeout=30
        )
        if result.returncode or self.detect() is not None:
            fail("Device eject failed; close applications using it", 409)


class Storage:
    def __init__(self, data: Path, devices: DeviceService):
        if data.resolve().is_relative_to(devices.mount.resolve()):
            raise RuntimeError("Application data and recoverable trash must be outside SWIM PRO")
        self.data = data
        self.library = data / "library"
        self.trash = data / "trash"
        self.staging = data / "staging"
        self.devices = devices
        for directory in (data, self.library, self.trash, self.staging):
            if any(p.is_symlink() for p in (directory, *directory.parents)):
                raise RuntimeError("Application data must not contain symlinks")
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def root(self, scope: str) -> tuple[Path, Device | None]:
        if scope == "library":
            return self.library, None
        d = self.devices.require()
        return d.root, d

    def check(self, device: Device | None) -> None:
        if device:
            self.devices.require(device)

    def file(self, scope: str, path: str) -> Path:
        root, device = self.root(scope)
        self.check(device)
        return selected(root, [path])[0]

    def copy(self, source: Path, target: Path, device: Device | None = None) -> None:
        self.check(device)
        target_root = device.root if device else self.data
        try:
            safe_path(target_root, target.relative_to(target_root).as_posix())
        except ValueError:
            fail("Copy destination escapes storage root")
        if any(p.is_symlink() for p in (source, *source.parents)):
            fail("Symlinks are not allowed")
        if collision(target):
            fail("Destination filename already exists", 409)
        tmp = target.parent / (".shokzlink-" + uuid.uuid4().hex + ".part")
        try:
            with source.open("rb") as src, tmp.open("xb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
                dst.flush()
                os.fsync(dst.fileno())
            if digest(source) != digest(tmp):
                fail("Copy content verification failed", 409)
            self.check(device)
            if collision(target):
                fail("Destination filename already exists", 409)
            exclusive_move(tmp, target)
            if digest(source) != digest(target):
                fail("Final content verification failed", 409)
        finally:
            tmp.unlink(missing_ok=True)

    def rename(self, scope: str, path: str, name: str) -> None:
        root, device = self.root(scope)
        source = selected(root, [path])[0]
        target = source.with_name(mp3_name(name))
        if target == source:
            return
        if collision(target, source):
            fail("Destination filename already exists", 409)
        self.check(device)
        exclusive_move(source, target)

    def move(self, scope: str, path: str | list[str], folder: str) -> None:
        paths = [path] if isinstance(path, str) else path
        root, device = self.root(scope)
        sources = selected(root, paths)
        parent = safe_path(root, folder, folder=True)
        if parent.exists() and not parent.is_dir():
            fail("Destination is not a folder")
        for source in sources:
            target = parent / source.name
            if target != source and collision(target):
                fail("Destination filename already exists", 409)
        self.check(device)
        parent.mkdir(parents=True, exist_ok=True)
        for source in sources:
            target = parent / source.name
            if target != source:
                exclusive_move(source, target)

    def create_folder(self, scope: str, folder: str) -> None:
        root, device = self.root(scope)
        target = safe_path(root, folder, folder=False)
        if target.exists():
            fail("Folder already exists", 409)
        self.check(device)
        target.mkdir(parents=True, exist_ok=True)

    def delete_folder(self, scope: str, folder: str) -> None:
        root, device = self.root(scope)
        target = safe_path(root, folder, folder=False)
        if not target.exists() or not target.is_dir():
            fail("Folder not found", 404)
        if any(target.iterdir()):
            fail("Folder is not empty", 400)
        self.check(device)
        target.rmdir()

    def delete(self, scope: str, paths: list[str]) -> int:
        root, device = self.root(scope)
        files = selected(root, paths)  # validate entire selection before touching anything
        batch = self.trash / uuid.uuid4().hex / scope
        batch.mkdir(parents=True)
        for source in files:
            target = batch / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            self.copy(source, target)
        # Every backup is verified before the first deletion.
        for source in files:
            self.check(device)
            if digest(source) != digest(batch / source.relative_to(root)):
                fail("Source changed; files retained", 409)
        for source in files:
            self.check(device)
            source.unlink()
        return len(files)

    def transfer(self, paths: list[str], folder: str) -> dict[str, int]:
        sources = selected(self.library, paths)
        device = self.devices.require()
        parent = safe_path(device.root, folder, folder=True)
        if parent.exists() and not parent.is_dir():
            fail("Destination is not a folder")
        names = [s.name.casefold() for s in sources]
        if len(set(names)) != len(names):
            fail("Selected filenames collide", 409)
        pending: list[tuple[Path, Path]] = []
        skipped = 0
        for source in sources:
            target = parent / source.name
            if collision(target):
                if target.is_file() and not target.is_symlink() and digest(source) == digest(target):
                    skipped += 1
                else:
                    fail("A different file already uses this destination name", 409)
            else:
                pending.append((source, target))
        required = sum(s.stat().st_size + 32768 for s, _ in pending)
        if required > min(device.free, shutil.disk_usage(device.root).free):
            fail("Not enough free space on SWIM PRO", 409)
        self.check(device)
        parent.mkdir(parents=True, exist_ok=True)
        for source, target in pending:
            self.copy(source, target, device)
        return {"copied": len(pending), "skipped": skipped}
