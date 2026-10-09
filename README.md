# ShokzLink

Manage your music library and prepare tracks for Shokz headphones with a local web app. Import MP3s, organize songs, download YouTube audio you have permission to use, and transfer tracks over USB.

ShokzLink is an independent community project, not an official Shokz application.

## Features

- Import, preview, rename, move, and remove MP3s in your local library.
- Detect a connected device, view available storage, and transfer selected tracks without silently overwriting files.
- Search public YouTube Music results and download permitted song or playlist URLs.
- Connect your YouTube Music account to browse playlists and liked songs.
- Review download progress, cancel jobs, and safely eject the device.

## Requirements

- **A computer with a modern browser** — see [Platform and device compatibility](#platform-and-device-compatibility) for current implementation limits.
- **Shokz headphones with onboard music storage and a USB data cable** — needed for device transfers; local library features work without headphones.
- **[Node.js](https://nodejs.org/) 22 or later** — includes npm.
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** and **Python 3.11 or later** — uv manages the project environment.
- **[FFmpeg](https://ffmpeg.org/)** available on `PATH` — needed to validate imported audio and convert downloads to MP3.

Python packages, including `yt-dlp` and `ytmusicapi`, are installed by `uv sync`. The app reports missing audio dependencies in Settings.

## Quick start

1. Clone or download this repository and open its directory in a terminal.
2. Install project-local dependencies and build the interface:

   ```sh
   uv sync --locked
   npm ci --prefix frontend
   npm run build --prefix frontend
   ```

3. Start the app:

   ```sh
   uv run uvicorn backend.app:app --host 127.0.0.1 --port 8765
   ```

4. Open **[http://127.0.0.1:8765](http://127.0.0.1:8765)** in your browser.

Keep the terminal open while using the app; press **Control-C** to stop the server. On macOS, `./start.command` performs installation, builds the interface, and starts the server in one command. The manual commands above avoid relying on that macOS launcher; they do not establish support for other operating systems.

## Use

1. Connect supported Shokz headphones with their USB data cable. For the current device detector, check the compatibility section below. Transfers never start automatically; Bluetooth cannot transfer MP3 files.
2. Import MP3s into the local library, or paste a YouTube or YouTube Music song/playlist URL and confirm that you have permission to download the audio.
3. Select local tracks and transfer them to the device. Existing files are never silently overwritten.
4. Use **Library** to preview, rename, move, or remove songs. Deletion requires confirmation; hidden and system device files cannot be managed.
5. Eject the device through the app before unplugging it.

Downloads started from a music card use its displayed song title, including featured artists. Pasted URLs use the title returned by YouTube. MP3 filenames preserve spaces and Thai text, omit internal video ID suffixes, and adjust unsafe characters or overly long names.

## Platform and device compatibility

ShokzLink combines a local music library with USB transfers for Shokz headphones that provide onboard storage. Bluetooth-only models cannot receive MP3 files through this workflow.

The current device detection and ejection code uses macOS `diskutil` and targets an OpenSwim Pro mounted at `/Volumes/SWIM PRO`, with the expected USB and FAT32 (รูปแบบระบบไฟล์ของไดรฟ์) properties. Windows, Linux, other Shokz models, and renamed device volumes are not supported by this detector. Local library and download features on other operating systems have not yet been verified.

Moving songs into folders changes their location on the device. Folder playback behavior depends on the Shokz firmware (ซอฟต์แวร์ภายในอุปกรณ์).

## YouTube Music account setup

Account access is optional. Public search, permitted URL downloads, and local MP3 imports do not require connecting a Google account.

ShokzLink uses `ytmusicapi` with Google's OAuth (การอนุญาตให้แอปเข้าถึงบัญชี) device authorization flow. You provide your own Google Cloud client credentials and sign in on Google's website; ShokzLink never asks for your Google password.

1. Create a Google Cloud project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen. If the project is in testing mode, add your Google account as a test user.
3. Create an **OAuth client ID** with the type **TVs and Limited Input devices**.
4. Open ShokzLink **Settings** and save the **Client ID** and **Client Secret**. They are stored privately on your computer, not in browser local storage.
5. Start sign-in, complete Google's authorization page, and open **YouTube Music** in the app to browse your playlists and liked songs.

Follow the [official ytmusicapi OAuth setup guide](https://ytmusicapi.readthedocs.io/en/stable/setup/oauth.html) for provider configuration. Google may require additional setup or reject authorization based on project or account policy.

Sign-in provides access to library information. It does not grant permission to download copyrighted audio or bypass protected streams.

## Privacy and safety

The current default directory for local music and account state is:

```text
~/Library/Application Support/ShokzLink/
```

- Credentials and tokens (ข้อมูลยืนยันสิทธิ์การเข้าถึง) stay in private local files. Never publish or commit them.
- The server listens only on `127.0.0.1` and rejects unexpected hosts and request origins (แหล่งที่มาของคำขอ). Do not expose it to the internet or place it behind a reverse proxy (ตัวกลางส่งต่อคำขอไปยังเซิร์ฟเวอร์).
- Device file operations are restricted to the detected USB volume (ไดรฟ์ที่ระบบเชื่อมต่อ). Hidden and system files are excluded.
- Device detection checks drive names and macOS disk information; it does not prove that the physical device is authentic.
- Search, sign-in, and downloads contact external services. Local storage does not mean these features work offline.

## Current limitations

- **Device transfers:** limited to the detector described in [Platform and device compatibility](#platform-and-device-compatibility); no Bluetooth file transfer.
- **YouTube playback:** embedded playback is available only where YouTube permits it. Full YouTube and YouTube Music open in separate browser tabs.
- **Downloads:** at most 100 playlist entries per job. External services can reject requests or change behavior. The app does not bypass DRM (ระบบป้องกันการคัดลอกสื่อ), login requirements, or anti-bot challenges (การตรวจจับและป้องกันบอต).
- **Account browsing:** requests up to 100 playlists and 500 tracks per playlist or liked-songs collection. Larger collections may be incomplete.
- **Queue history:** held in memory and cleared when the server restarts.

## Development

The Python server uses FastAPI; the interface uses React, TypeScript, and Vite. See [API.md](API.md) for the API contract (ข้อตกลงรูปแบบการเรียกใช้งานและข้อมูล).

### Install and check

Run these commands from the repository root:

```sh
uv sync --locked
npm ci --prefix frontend
uv run pytest
uv run ruff check backend
npm test --prefix frontend
npm run build --prefix frontend
```

### Run with live interface updates

1. Start the server in one terminal:

   ```sh
   uv run uvicorn backend.app:app --host 127.0.0.1 --port 8765 --reload --reload-dir backend
   ```

2. Start Vite in a second terminal:

   ```sh
   npm run dev --prefix frontend
   ```

3. Open **[http://127.0.0.1:5173](http://127.0.0.1:5173)**. Vite forwards API requests to the server on port 8765.

Automated tests use temporary files and simulated external responses. Passing them does not establish successful real-account sign-in, live YouTube downloads, or transfers to physical headphones.

## Contributing

Bug reports and focused pull requests are welcome. For a bug report, include your operating system and version, device model, steps to reproduce, and the error message. Remove credentials, tokens, and personal account information before sharing logs.

Keep changes scoped, add tests for behavior changes, and run the checks above before submitting a pull request. Test file operations with temporary directories rather than your device's music collection.

## License

No license file is currently included. Reuse and redistribution permissions have not yet been defined by a project license.
