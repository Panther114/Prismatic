# Prismatic

Cinematic music visualizer — live spectral stage, vinyl player, and **browser-side video export**.

The host (including [Railway](https://railway.app)) only serves the static app and a tiny health API.  
**All heavy work — FFT preview, canvas, and video encoding — runs on the user’s machine**, so the server stays low-RAM.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/new?referralCode=prismatic)

Or: **New Project → Deploy from GitHub** and point at this repo. Railway picks up `railway.toml` / `pnpm start` automatically.

## Features

- Import audio in the browser (or, in local dev, from a `music/` folder + watched folders)
- Live audio-reactive visualizer with water ripples, spectrum pillars, and vinyl cover art
- Export masters with **MediaRecorder in Chrome / Edge / Firefox** (WebM, or MP4 when the browser supports it)
- Resolution presets: 720p, 1080p, 4K, square, portrait

## Quick start (local)

```bash
pnpm install
pnpm dev          # http://localhost:4100
```

Windows: double-click `quickrun.bat` if you use it.

Requirements: **Node.js 22+**. No FFmpeg required for normal use.

## Deploy (Railway)

1. Push this repo to GitHub.
2. Create a Railway project from the repo (or use the deploy button).
3. Railway runs `pnpm install` → `pnpm build` → `pnpm start`.
4. Open the public URL. Import tracks in the browser and render there.

Optional env:

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (Railway sets this) |
| `PRISMATIC_CLOUD=1` | Force cloud mode (no disk library) even in dev |
| `PRISMATIC_LOCAL=1` | Force local library APIs even in production (not recommended on Railway) |

## Architecture

| Layer | Responsibility |
|-------|----------------|
| **Browser** | Audio decode, live visualizer, MediaRecorder export, downloads |
| **Server (cloud)** | Static SPA + `/api/health` |
| **Server (local dev)** | Vite + optional `music/` library / watch folders — still no server encode |

Server-side `@napi-rs/canvas` + FFmpeg export is **optional** (`optionalDependencies` + scripts) and is not used by the web app.

## Commands

```bash
pnpm dev       # local studio
pnpm build     # production client → dist/
pnpm start     # serve dist/ (production / Railway)
pnpm check     # typecheck + build
```

## License

Private / your project — adjust as needed.
