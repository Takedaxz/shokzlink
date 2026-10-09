"""Bounded yt-dlp jobs. No browser cookies, DRM bypass, or anti-bot workarounds."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import signal
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .storage import FFMPEG, Storage, collision, fail, mp3_name, valid_audio

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
PLAYLIST_ID = re.compile(r"[A-Za-z0-9_-]{2,150}")


def download_filename(title: str) -> str:
    """Keep the displayed title, changing only filesystem-unsafe characters and length."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip(" .")
    while len(name.encode("utf-8")) > 236:
        name = name[:-1]
    return mp3_name(name.rstrip(" .") + ".mp3")


def youtube_url(value: str) -> str:
    try:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or url.username
            or url.password
            or url.port not in {None, 443}
            or url.hostname not in {"youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"}
            or url.fragment
        ):
            fail("Use an HTTPS YouTube video or playlist URL")
        query = parse_qs(url.query)
        if url.hostname == "youtu.be":
            video = url.path.removeprefix("/")
        elif url.path == "/watch":
            video = query.get("v", [""])[0]
        elif url.path.startswith(("/shorts/", "/live/", "/embed/")):
            video = url.path.split("/")[-1]
        else:
            video = ""
        playlist = query.get("list", [""])[0]
        if video and VIDEO_ID.fullmatch(video):
            # Canonicalization strips arbitrary parameters/redirect URLs.
            return "https://www.youtube.com/watch?v=" + video
        if url.path == "/playlist" and PLAYLIST_ID.fullmatch(playlist):
            return "https://www.youtube.com/playlist?list=" + playlist
    except ValueError:
        pass
    fail("Use a valid YouTube video or playlist URL")
    return ""


@dataclass
class Job:
    id: str
    url: str
    status: str = "queued"
    progress: float = 0
    message: str = "Waiting in queue"
    created: float = field(default_factory=time.time)
    cancelled: bool = False
    finalizing: bool = False
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task[None] | None = None
    title: str | None = None

    def public(self) -> dict[str, object]:
        return {
            "id": self.id,
            "url": self.url,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "created": self.created,
        }


class Downloads:
    def __init__(self, storage: Storage, mutation: asyncio.Lock):
        self.storage = storage
        self.mutation = mutation
        self.jobs: dict[str, Job] = {}
        self.queue = asyncio.Semaphore(1)

    def add(self, url: str, title: str | None = None) -> Job:
        normalized = youtube_url(url)
        if title is not None:
            if urlsplit(normalized).path != "/watch":
                fail("A display title can only be supplied for a single song")
            download_filename(title)
        if not Path(FFMPEG).is_file():
            fail("ffmpeg is required for MP3 downloads", 503)
        if sum(j.status in {"queued", "downloading"} for j in self.jobs.values()) >= 50:
            fail("Download queue is full", 429)
        # Bound retained history; active jobs are never discarded.
        if len(self.jobs) >= 200:
            for identifier in list(self.jobs):
                if self.jobs[identifier].status in {"completed", "failed", "cancelled"}:
                    del self.jobs[identifier]
                    break
        job = Job(uuid.uuid4().hex, normalized, title=title)
        self.jobs[job.id] = job
        job.task = asyncio.create_task(self.run(job))
        return job

    @staticmethod
    def terminate(job: Job) -> None:
        if job.process and job.process.returncode is None:
            try:
                os.killpg(job.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                # macOS may deny a second group signal while the child is being reaped.
                try:
                    job.process.terminate()
                except (ProcessLookupError, PermissionError):
                    pass

    async def cancel(self, identifier: str) -> None:
        job = self.jobs.get(identifier)
        if job is None:
            fail("Download job not found", 404)
        if job.finalizing:
            fail("Download is finalizing into the library; cancellation is no longer available", 409)
        if job.status in {"queued", "downloading"}:
            job.cancelled = True
            self.terminate(job)
            if job.task:
                job.task.cancel()
                try:
                    await job.task
                except asyncio.CancelledError:
                    pass
            job.status, job.message = "cancelled", "Download cancelled"

    def commit(self, files: list[Path], title: str | None = None) -> int:
        if not files:
            fail("No MP3 audio was produced", 502)
        if title is not None and len(files) != 1:
            fail("A single-song download produced an unexpected number of files", 502)
        names: set[str] = set()
        outputs: list[tuple[Path, Path]] = []
        for source in files:
            mp3_name(source.name)
            valid_audio(source)
            source_title = re.sub(r" \[[A-Za-z0-9_-]{11}\]$", "", source.stem)
            name = download_filename(title if title is not None else source_title)
            target = self.storage.library / name
            if name.casefold() in names or collision(target):
                fail("Downloaded filename already exists in library", 409)
            names.add(name.casefold())
            outputs.append((source, target))
        if sum(source.stat().st_size for source in files) > shutil.disk_usage(self.storage.library).free:
            fail("Not enough library storage space", 409)
        for source, target in outputs:
            self.storage.copy(source, target)
        return len(files)

    async def run(self, job: Job) -> None:
        folder = self.storage.staging / job.id
        try:
            async with self.queue:
                if job.cancelled:
                    raise asyncio.CancelledError
                folder.mkdir(mode=0o700)
                job.status, job.message = "downloading", "Downloading audio"
                command = [
                    sys.executable,
                    "-m",
                    "yt_dlp",
                    "--ignore-config",
                    "--no-cache-dir",
                    "--no-overwrites",
                    "--no-restrict-filenames",
                    "--windows-filenames",
                    "--newline",
                    "--no-warnings",
                    "--progress",
                    "--progress-template",
                    "download:SHOKZPROGRESS %(progress._percent_str)s",
                    "--socket-timeout",
                    "20",
                    "--retries",
                    "2",
                    "--fragment-retries",
                    "2",
                    "--playlist-end",
                    "100",
                    "--max-filesize",
                    "500M",
                    "--no-write-info-json",
                    "--ffmpeg-location",
                    str(Path(FFMPEG).parent),
                    "-x",
                    "--audio-format",
                    "mp3",
                    "--format",
                    "bestaudio/best",
                    "--audio-quality",
                    "0",
                    "-o",
                    str(folder / "%(title).150B [%(id)s].%(ext)s"),
                    "--",
                    job.url,
                ]
                job.process = await asyncio.create_subprocess_exec(
                    *command,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                    start_new_session=True,
                )
                assert job.process.stdout is not None
                async with asyncio.timeout(3600):
                    async for line in job.process.stdout:
                        text = line.decode(errors="replace")
                        if text.startswith("SHOKZPROGRESS"):
                            percent = re.search(r"([\d.]+)%", text)
                            if percent:
                                job.progress = min(95, max(job.progress, float(percent[1])))
                                job.message = "Downloading audio; conversion and validation follow"
                    code = await job.process.wait()
                if code:
                    job.status, job.message = (
                        "failed",
                        (
                            "YouTube download unavailable: private, restricted, rights-blocked, or sign-in required. "
                            "No access restrictions were bypassed."
                        ),
                    )
                    return
                job.message = "Validating MP3 audio and adding to library"
                async with self.mutation:
                    job.finalizing = True
                    # A shield keeps the lock held until the filesystem thread has really finished.
                    operation = asyncio.create_task(
                        asyncio.to_thread(self.commit, sorted(folder.glob("*.mp3")), job.title)
                    )
                    try:
                        count = await asyncio.shield(operation)
                    except asyncio.CancelledError:
                        count = await operation
                        job.status, job.progress, job.message = "completed", 100, f"Added {count} MP3 file(s)"
                        return
                job.status, job.progress, job.message = "completed", 100, f"Added {count} MP3 file(s)"
        except asyncio.CancelledError:
            job.status, job.message = "cancelled", "Download cancelled"
        except TimeoutError:
            job.status, job.message = "failed", "Download timed out"
        except Exception:
            job.status, job.message = "failed", "Download or audio validation failed; no files overwritten"
        finally:
            job.finalizing = False
            self.terminate(job)
            if job.process and job.process.returncode is None:
                try:
                    await asyncio.wait_for(job.process.wait(), timeout=5)
                except TimeoutError:
                    try:
                        os.killpg(job.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        try:
                            job.process.kill()
                        except ProcessLookupError:
                            pass
                    await job.process.wait()
            await asyncio.to_thread(shutil.rmtree, folder, True)

    async def close(self) -> None:
        for identifier in list(self.jobs):
            job = self.jobs[identifier]
            if job.finalizing and job.task:
                await job.task
            else:
                await self.cancel(identifier)
            if job.task and not job.task.done():
                await job.task
