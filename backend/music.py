"""YouTube Music and Google device OAuth; credentials never leave local private files."""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import requests
from ytmusicapi import OAuthCredentials, YTMusic

from .storage import fail, safe_path

SCOPE = "https://www.googleapis.com/auth/youtube"


class TimeoutSession(requests.Session):
    """Bound otherwise unbounded ytmusicapi and OAuth refresh HTTP requests."""

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        kwargs["timeout"] = 20
        return super().request(method, url, **kwargs)


def private_json(path: Path, data: dict[str, object]) -> None:
    safe_path(path.parent, path.name)
    temp = path.with_name("." + uuid.uuid4().hex)
    try:
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        os.chmod(path, 0o600)
    finally:
        temp.unlink(missing_ok=True)


def read_private(path: Path) -> dict[str, object]:
    if any(p.is_symlink() for p in (path, *path.parents)):
        fail("Unsafe authentication storage", 409)
    if not path.exists():
        return {}
    os.chmod(path, 0o600)
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            fail("Local authentication data is invalid; configure sign-in again", 409)
        return data
    except (ValueError, OSError):
        fail("Local authentication data is unreadable; configure sign-in again", 409)
    return {}


@dataclass
class Flow:
    code: str
    expires: float
    interval: int
    next_poll: float
    status: str = "pending"
    message: str = "Complete sign-in in your browser"


class Music:
    def __init__(self, data: Path):
        self.config_path = data / "oauth-client.json"
        self.token_path = data / "oauth.json"
        self.flows: dict[str, Flow] = {}
        self.lock = asyncio.Lock()

    def status(self) -> dict[str, bool]:
        config = read_private(self.config_path)
        token = read_private(self.token_path)
        return {
            "configured": bool(config.get("client_id") and config.get("client_secret")),
            "authenticated": bool(token.get("refresh_token")),
        }

    def credentials(self) -> dict[str, str]:
        config = read_private(self.config_path)
        identifier, secret = config.get("client_id"), config.get("client_secret")
        if not isinstance(identifier, str) or not isinstance(secret, str) or not identifier or not secret:
            fail("Configure OAuth credentials first", 409)
        return {"client_id": identifier, "client_secret": secret}

    def configure(self, client_id: str, client_secret: str) -> None:
        if not client_id.endswith(".apps.googleusercontent.com") or not client_secret.strip():
            fail("Enter a Google TV/limited-input OAuth client ID and secret")
        private_json(self.config_path, {"client_id": client_id, "client_secret": client_secret})
        self.logout()

    def logout(self) -> None:
        self.token_path.unlink(missing_ok=True)
        self.flows.clear()

    async def request(self, url: str, data: dict[str, str]) -> dict[str, Any]:
        # This is the untyped external JSON boundary; never propagate upstream bodies/errors.
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
                response = await client.post(url, data=data)
                value = response.json()
                if not isinstance(value, dict):
                    fail("Google authentication service returned an invalid response", 502)
                if response.status_code >= 500:
                    fail("Google authentication service unavailable", 502)
                return value
        except (httpx.HTTPError, ValueError):
            fail("Google authentication service unavailable", 502)
        return {}

    async def start(self) -> dict[str, object]:
        config = self.credentials()
        response = await self.request(
            "https://oauth2.googleapis.com/device/code", {"client_id": config["client_id"], "scope": SCOPE}
        )
        try:
            code = str(response["device_code"])
            url = str(response.get("verification_url") or response["verification_uri"])
            if url not in {
                "https://www.google.com/device",
                "https://www.google.com/device/",
                "https://google.com/device",
                "https://accounts.google.com/device",
            }:
                fail("Google returned an unexpected verification URL", 502)
            expires = int(response["expires_in"])
            interval = max(5, int(response.get("interval", 5)))
            identifier = uuid.uuid4().hex
            self.flows = {identifier: Flow(code, time.time() + expires, interval, time.time() + interval)}
            return {
                "id": identifier,
                "verificationUrl": url,
                "userCode": str(response["user_code"]),
                "expiresIn": expires,
            }
        except (KeyError, ValueError, TypeError):
            fail("Unable to start OAuth; check TV/limited-input client configuration", 502)
        return {}

    async def poll(self, identifier: str) -> dict[str, str]:
        flow = self.flows.get(identifier)
        if not flow:
            fail("Sign-in request not found", 404)
        if flow.status != "pending":
            return {"status": flow.status, "message": flow.message}
        if time.time() >= flow.expires:
            flow.status, flow.message = "expired", "Sign-in code expired; start again"
        elif time.time() >= flow.next_poll:
            flow.next_poll = time.time() + flow.interval
            config = self.credentials()
            response = await self.request(
                "https://oauth2.googleapis.com/token",
                {
                    "client_id": config["client_id"],
                    "client_secret": config["client_secret"],
                    "device_code": flow.code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
            )
            error = response.get("error")
            if error == "slow_down":
                flow.interval += 5
                flow.next_poll = time.time() + flow.interval
            elif error == "authorization_pending":
                pass
            elif error == "access_denied":
                flow.status, flow.message = "denied", "Sign-in was denied"
            elif error == "expired_token":
                flow.status, flow.message = "expired", "Sign-in code expired; start again"
            elif error or not response.get("access_token") or not response.get("refresh_token"):
                flow.status, flow.message = "failed", "Sign-in failed; verify OAuth client configuration"
            else:
                try:
                    expires = int(response["expires_in"])
                    token = {
                        "access_token": response["access_token"],
                        "refresh_token": response["refresh_token"],
                        "token_type": response.get("token_type", "Bearer"),
                        "scope": response.get("scope", SCOPE),
                        "expires_in": expires,
                        "expires_at": int(time.time()) + expires,
                    }
                    private_json(self.token_path, token)
                    flow.status, flow.message = "authenticated", "Signed in to YouTube Music"
                    flow.code = ""
                except (ValueError, KeyError, TypeError):
                    flow.status, flow.message = "failed", "Google returned an invalid token"
        return {"status": flow.status, "message": flow.message}

    def client(self) -> YTMusic:
        if not self.status()["authenticated"]:
            fail("Sign in to YouTube Music first", 401)
        config = self.credentials()
        try:
            session = TimeoutSession()
            return YTMusic(
                str(self.token_path),
                requests_session=session,
                oauth_credentials=OAuthCredentials(
                    client_id=config["client_id"], client_secret=config["client_secret"], session=session
                ),
            )
        except Exception:
            fail("YouTube Music authentication failed; sign in again", 401)
        raise RuntimeError("Unreachable")

    def search(self, query: str) -> list[dict[str, object]]:
        try:
            rows = YTMusic(requests_session=TimeoutSession()).search(query, filter="songs", limit=20)
            return videos(rows[:20])
        except Exception:
            fail("YouTube Music search unavailable; try again later", 502)
        return []

    def playlists(self) -> list[dict[str, object]]:
        client = self.client()
        try:
            rows = client.get_library_playlists(limit=100)
            result = [{"id": "LM", "title": "Liked songs", "count": None, "thumbnail": None}]
            for row in rows:
                if row.get("playlistId") and row["playlistId"] != "LM":
                    result.append(
                        {
                            "id": row["playlistId"],
                            "title": row.get("title", "Playlist"),
                            "count": str(row["count"]) if row.get("count") is not None else None,
                            "thumbnail": thumbnail(row),
                        }
                    )
            return result
        except Exception:
            fail("Unable to load personal playlists; sign in again or retry later", 502)
        return []

    def playlist(self, identifier: str) -> list[dict[str, object]]:
        client = self.client()
        try:
            data = (
                client.get_liked_songs(limit=500)
                if identifier == "LM"
                else client.get_playlist(identifier, limit=500)
            )
            return videos(data.get("tracks", []))
        except Exception:
            fail("Unable to load playlist; it may be private or unavailable", 502)
        return []


def thumbnail(row: dict[str, Any]) -> str | None:
    thumbs = row.get("thumbnails", [])
    url = thumbs[-1].get("url") if thumbs else None
    return url if isinstance(url, str) and url.startswith("https://") else None


def videos(rows: list[dict[str, Any]]) -> list[dict[str, object]]:
    result = []
    for row in rows:
        identifier = row.get("videoId")
        if (
            not isinstance(identifier, str)
            or len(identifier) != 11
            or not all(c.isalnum() or c in "_-" for c in identifier)
        ):
            continue
        result.append(
            {
                "id": identifier,
                "title": str(row.get("title", "Untitled")),
                "artist": ", ".join(str(a.get("name", "")) for a in row.get("artists", [])),
                "thumbnail": thumbnail(row),
                "duration": row.get("duration"),
                "url": "https://www.youtube.com/watch?v=" + identifier,
            }
        )
    return result
