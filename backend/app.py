"""Local-only ShokzLink ASGI application. Run on 127.0.0.1:8765 only."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import shutil
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, TypeVar

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from .downloads import Downloads
from .music import Music
from .storage import FFMPEG, DeviceService, Storage, collision, fail, inventory, mp3_name, safe_path, valid_audio

PROJECT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = Path.home() / "Library/Application Support/ShokzLink"
ALLOWED_HOSTS = {"127.0.0.1:8765", "localhost:8765", "127.0.0.1", "localhost"}
ALLOWED_ORIGINS = {
    "http://127.0.0.1:8765",
    "http://localhost:8765",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
}
T = TypeVar("T")


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Scoped(Input):
    scope: Literal["library", "device"]
    path: str = Field(min_length=1, max_length=1024)


class Rename(Scoped):
    name: str = Field(min_length=1, max_length=240)


class Move(Input):
    scope: Literal["library", "device"]
    path: str = Field(default="", max_length=1024)
    paths: list[str] = Field(default_factory=list, max_length=500)
    folder: str = Field(default="", max_length=1024)


class FolderCreate(Input):
    scope: Literal["library", "device"]
    folder: str = Field(min_length=1, max_length=1024)


class FolderDelete(Input):
    scope: Literal["library", "device"]
    folder: str = Field(min_length=1, max_length=1024)


class Transfer(Input):
    paths: list[str] = Field(min_length=1, max_length=500)
    folder: str = Field(default="", max_length=1024)


class Delete(Input):
    scope: Literal["library", "device"]
    paths: list[str] = Field(min_length=1, max_length=500)
    confirm: StrictBool

    @field_validator("confirm")
    @classmethod
    def confirmed(cls, value: bool) -> bool:
        if not value:
            raise ValueError("Explicit confirmation is required")
        return value


class Download(Input):
    url: str = Field(min_length=1, max_length=2048)
    permitted: bool | None = None
    title: str | None = Field(default=None, min_length=1, max_length=1000)


class AuthConfig(Input):
    clientId: str = Field(min_length=1, max_length=500, repr=False)
    clientSecret: str = Field(min_length=1, max_length=500, repr=False)


async def serialized(lock: asyncio.Lock, function: Callable[[], T]) -> T:
    async with lock:
        task = asyncio.create_task(asyncio.to_thread(function))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            await task  # retain lock until the worker is finished
            raise


def create_app(data: Path | None = None, devices: DeviceService | None = None) -> FastAPI:
    configured = Path(os.environ.get("SHOKZLINK_DATA_DIR", str(DEFAULT_DATA)))
    if not configured.is_absolute():
        configured = PROJECT / configured
    storage = Storage(data or configured, devices or DeviceService())
    mutation = asyncio.Lock()
    music = Music(storage.data)
    downloads = Downloads(storage, mutation)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        yield
        await downloads.close()

    application = FastAPI(title="ShokzLink", lifespan=lifespan, docs_url=None, redoc_url=None)
    application.state.storage = storage
    application.state.music = music
    application.state.downloads = downloads
    application.state.mutation = mutation

    @application.middleware("http")
    async def local_only(request: Request, call_next):
        host = request.headers.get("host", "").lower()
        origin = request.headers.get("origin")
        if (
            host not in ALLOWED_HOSTS
            or (origin is not None and origin not in ALLOWED_ORIGINS)
            or request.headers.get("sec-fetch-site") == "cross-site"
        ):
            return JSONResponse({"detail": "Only local same-origin requests are allowed"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "no-cache"
        # No CORS headers. Vite uses a same-origin /api proxy.
        return response

    @application.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        return JSONResponse(
            {"detail": "Invalid request; check required fields and confirmations"}, status_code=422
        )

    @application.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception):
        return JSONResponse(
            {"detail": "Operation failed safely; reconnect the device or retry"}, status_code=500
        )

    @application.get("/api/health")
    async def health():
        return {"ok": True}

    @application.get("/api/status")
    async def status():
        jobs = [j.public() for j in downloads.jobs.values()]

        def snapshot():
            library, folders = inventory(storage.library)
            return {
                "device": storage.devices.status(),
                "library": library,
                "folders": folders,
                "jobs": jobs,
                "dependencies": {
                    "ffmpeg": Path(FFMPEG).is_file(),
                    "yt_dlp": importlib.util.find_spec("yt_dlp") is not None,
                },
                "auth": music.status(),
                "libraryPath": str(storage.library),
            }

        async with music.lock:
            return await serialized(mutation, snapshot)

    @application.post("/api/library/import")
    async def import_files(
        files: list[UploadFile] = File(...),
        folder: str = Form(""),
        scope: str = Form("library"),
    ):
        if not files or len(files) > 100:
            fail("Import 1–100 MP3 files at a time")
        if scope not in ("library", "device"):
            fail("Invalid storage scope")
        folder_staging = storage.staging / uuid.uuid4().hex
        folder_staging.mkdir(mode=0o700)
        staged: list[Path] = []
        total = 0
        try:
            names: set[str] = set()
            for upload in files:
                name = mp3_name(upload.filename or "")
                if name.casefold() in names:
                    fail("Import filenames collide", 409)
                names.add(name.casefold())
                target = folder_staging / name
                size = 0
                with target.open("xb") as stream:
                    while chunk := await upload.read(1024 * 1024):
                        size += len(chunk)
                        total += len(chunk)
                        if size > 100 * 1024 * 1024 or total > 500 * 1024 * 1024:
                            fail("Import exceeds size limit", 413)
                        stream.write(chunk)
                staged.append(target)

            def commit():
                root_path, dev = storage.root(scope)
                parent = safe_path(root_path, folder, folder=True)
                parent.mkdir(parents=True, exist_ok=True)
                for source in staged:
                    valid_audio(source)
                    if collision(parent / source.name):
                        fail(f"Filename already exists: {source.name}", 409)
                available = dev.free if dev else shutil.disk_usage(root_path).free
                if sum(s.stat().st_size for s in staged) > available:
                    fail("Not enough storage space", 409)
                for source in staged:
                    storage.copy(source, parent / source.name, dev)
                return {"imported": len(staged)}

            return await serialized(mutation, commit)
        finally:
            for upload in files:
                await upload.close()
            shutil.rmtree(folder_staging, ignore_errors=True)

    @application.post("/api/files/rename")
    async def rename(body: Rename):
        await serialized(mutation, lambda: storage.rename(body.scope, body.path, body.name))
        return {"ok": True}

    @application.post("/api/files/move")
    async def move(body: Move):
        target_paths = body.paths if body.paths else ([body.path] if body.path else [])
        if not target_paths:
            fail("No files specified to move")
        await serialized(mutation, lambda: storage.move(body.scope, target_paths, body.folder))
        return {"ok": True}

    @application.post("/api/folders/create")
    async def create_folder(body: FolderCreate):
        await serialized(mutation, lambda: storage.create_folder(body.scope, body.folder))
        return {"ok": True}

    @application.post("/api/folders/delete")
    async def delete_folder(body: FolderDelete):
        await serialized(mutation, lambda: storage.delete_folder(body.scope, body.folder))
        return {"ok": True}

    @application.post("/api/files/delete")
    async def delete(body: Delete):
        count = await serialized(mutation, lambda: storage.delete(body.scope, body.paths))
        return {"deleted": count}

    @application.get("/api/files/stream")
    async def stream_file(scope: str = Query(...), path: str = Query(...)):
        if scope not in ("library", "device"):
            fail("Invalid storage scope")
        file_path = await asyncio.to_thread(storage.file, scope, path)
        return FileResponse(file_path, media_type="audio/mpeg", headers={"Accept-Ranges": "bytes"})


    @application.post("/api/transfer")
    async def transfer(body: Transfer):
        return await serialized(mutation, lambda: storage.transfer(body.paths, body.folder))

    @application.post("/api/device/eject")
    async def eject():
        await serialized(mutation, storage.devices.eject)
        return {"ok": True}

    @application.post("/api/downloads")
    async def add_download(body: Download):
        return downloads.add(body.url, body.title).public()

    @application.post("/api/downloads/{identifier}/cancel")
    async def cancel_download(identifier: str):
        await downloads.cancel(identifier)
        return {"ok": True}

    @application.get("/api/youtube/search")
    async def search(q: str = Query(min_length=1, max_length=200)):
        if not q.strip():
            fail("Enter a search query")
        return {"videos": await asyncio.to_thread(music.search, q.strip())}

    @application.post("/api/auth/config")
    async def configure(body: AuthConfig):
        await serialized(music.lock, lambda: music.configure(body.clientId, body.clientSecret))
        return {"configured": True}

    @application.post("/api/auth/start")
    async def start_auth():
        async with music.lock:
            return await music.start()

    @application.get("/api/auth/poll/{identifier}")
    async def poll_auth(identifier: str):
        async with music.lock:
            return await music.poll(identifier)

    @application.post("/api/auth/logout")
    async def logout():
        await serialized(music.lock, music.logout)
        return {"ok": True}

    @application.get("/api/music/playlists")
    async def playlists():
        return {"playlists": await serialized(music.lock, music.playlists)}

    @application.get("/api/music/playlists/{identifier}")
    async def playlist(identifier: str):
        if not identifier or len(identifier) > 150 or not all(c.isalnum() or c in "_-" for c in identifier):
            fail("Invalid playlist ID")
        return {"videos": await serialized(music.lock, lambda: music.playlist(identifier))}

    # Do not turn misspelled API paths into a successful SPA response.
    @application.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
    async def missing_api(path: str):
        raise HTTPException(404, "API endpoint not found")

    dist = PROJECT / "frontend/dist"
    if dist.is_dir():
        application.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    return application


app = create_app()
