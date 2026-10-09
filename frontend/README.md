# ShokzLink frontend

React 19 + TypeScript + Vite. All app data comes from the same-origin API described in `../API.md`; no demo data or browser credential persistence.

## Commands

```sh
npm ci
npm run dev          # http://127.0.0.1:5173; /api proxies to 127.0.0.1:8765
npm run build        # frontend/dist, served by the local backend
npm test            # helper and component checks
node tests/ui-check.mjs # read-only Chromium checks; start Vite first
```

Install the test browser once with `npx playwright install chromium`. Browser checks explicitly intercept API reads with isolated test fixtures, refuse mutation requests, and do not interact with any real device. The initial offline-state check expects the backend not to be running. Unit tests mock HTTP and native dialog methods; browser checks exercise real dialog behavior.

## Implemented

- Three-second sequential status polling, server errors, live device storage and dependency status.
- Two-pane MP3 management: search, sort, multiselect, MP3 import, confirmed manual transfers, rename, folder moves, explicitly named/count-confirmed deletion and eject.
- Public YouTube search, video cards, optional youtube-nocookie playback, separate external YouTube and YouTube Music links.
- Personal playlists and liked songs from the account API.
- Permission-gated video/playlist URL downloads, actual job progress, cancellation.
- OAuth TV client configuration, masked client-secret field, Google device code and verification link, expiry, polling at a minimum five-second interval with optional backend interval/slow-down handling. No Google password fields.
- Keyboard focus, native modal focus trap/Escape behavior, responsive layout, 44px button/form-control targets.

## Boundaries

Backend owns USB validation, path safety, content validation, file collisions, atomic transfer, trash, secret permissions, Google OAuth and download execution. Batch moves use the contract's per-file endpoint sequentially; a failure reports how many already moved, so they are not atomic as a group. Changing device mounts clears device selections.

Keep Settings open while approving the device code; leaving Settings stops local polling. The code can still expire at Google. Playback embedding depends on the video owner's permissions and is not a full signed-in YouTube website. Device mutations and real-account OAuth were intentionally not exercised during frontend checks.
