# ShokzLink API contract

Local-only FastAPI application at http://127.0.0.1:8765, serving a built React/Vite frontend. Development Vite proxies /api to that address. JSON errors use {detail: string}. Backend binds loopback only. No writes to connected device during development or verification; test mutations use temporary directories.

## Data

Track: {path: string (relative POSIX path), name: string (filename), title: string (stem), size: number, modified: number (Unix seconds)}.
Device: {connected: boolean, name: string|null, mount: string|null, total: number, free: number, tracks: Track[], folders: string[]}.
Job: {id: string, url: string, status: 'queued'|'downloading'|'completed'|'failed'|'cancelled', progress: number (0-100), message: string, created: number}.
Video: {id: string, title: string, artist: string, thumbnail: string|null, duration: string|null, url: string}.
Playlist: {id: string, title: string, count: string|null, thumbnail: string|null}.

## Endpoints

- GET /api/status -> {device: Device, library: Track[], folders: string[], jobs: Job[], dependencies: {ffmpeg: boolean, yt_dlp: boolean}, auth: {configured: boolean, authenticated: boolean}, libraryPath: string}. Polled every 3 seconds by UI for hot-plug/queue updates.
- POST /api/library/import multipart `files` (multiple .mp3 files) -> {imported: number}. Must reject invalid audio and collision; do not overwrite.
- POST /api/files/rename {scope: 'library'|'device', path: string, name: string} -> {ok: true}. Validate safe MP3 basename; no overwrite.
- POST /api/files/move {scope, path, folder: string} -> {ok: true}. Move inside same scope into an existing or newly-created folder. Folder traversal forbidden; system/hidden device folders forbidden.
- POST /api/files/delete {scope, paths: string[], confirm: true} -> {deleted: number}. UI displays confirmation modal. Device removals explicit only; prefer recoverable app trash outside device rather than permanent deletion.
- POST /api/transfer {paths: string[], folder: string} -> {copied: number, skipped: number}. Only library -> current validated device. Never overwrite existing files; compare content or report collisions. Atomic finalization, free-space checks, disconnection handling.
- POST /api/device/eject -> {ok: true}. UI confirmation; diskutil eject for validated detected external disk.
- POST /api/downloads {url: string, permitted: true, title?: string} -> Job. Card downloads pass the displayed title for a single song so the MP3 filename matches it (apart from filesystem-unsafe characters/length). Final library names omit the internal YouTube ID suffix and preserve Unicode. A title override is rejected for playlist URLs. Accept HTTPS YouTube/music.youtube.com/youtu.be video and playlist URLs only. User must check rights confirmation. No DRM bypass. Jobs use yt-dlp and ffmpeg, cancellation and actual progress. No cookie extraction or anti-bot circumvention.
- POST /api/downloads/{id}/cancel -> {ok: true}.
- GET /api/youtube/search?q=... -> {videos: Video[]}. Public search with ytmusicapi, bounded results. Browsing UI has search cards, links opening youtube.com and music.youtube.com separately, URL paste, optional YouTube nocookie video iframe playback (not a full embedded YouTube website).
- POST /api/auth/config {clientId: string, clientSecret: string} -> {configured: true}. OAuth TV/limited-input client per ytmusicapi official setup https://ytmusicapi.readthedocs.io/en/stable/setup/oauth.html. Credentials and tokens stored only locally with mode 0600, never returned/logged.
- POST /api/auth/start -> {id: string, verificationUrl: string, userCode: string, expiresIn: number}. Google device OAuth; frontend shows link/code. No password fields in app.
- GET /api/auth/poll/{id} -> {status: 'pending'|'authenticated'|'expired'|'denied'|'failed', message: string}. Backend obeys polling interval and slow_down; no secrets returned.
- POST /api/auth/logout -> {ok: true}.
- GET /api/music/playlists -> {playlists: Playlist[]} (includes liked songs).
- GET /api/music/playlists/{id} -> {videos: Video[]}.

## Security

Check Host and Origin against local origins to prevent DNS rebinding and cross-origin local filesystem changes; no wildcard CORS. Same-origin requests only (dev 127.0.0.1:5173/localhost:5173 allowed). Every resolved path must remain within current root, reject symlinks and protected device dirs. Identify SWIM PRO via macOS diskutil metadata (external, USB, FAT filesystem, expected label; avoid trusting arbitrary folders). Single serialized mutation lock to prevent file races. No shell invocation for external commands. Validate every selected file before batch mutation. Generic sanitized upstream errors, no raw tokens/headers/logs.
