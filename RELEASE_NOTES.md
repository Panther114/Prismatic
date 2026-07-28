# Prismatic 2.1.4

## Railway: share-only + cold start

- **Website removed from Railway** — the cloud service no longer serves the SPA. It is a **playlist-share API only** (`/api/health`, `/api/playlist-share/*`).
- **Desktop is the product** — library, playback, studio, and auto-update stay on the desktop app (GitHub Releases).
- **Cold-start friendly client** — share/import **wakes** `https://prismatic.up.railway.app` (health ping + retries on 502/network) before upload/download so Railway **Serverless** can sleep when idle.
- **Disk-backed share** (from 2.1.3) + **single concurrent upload** + **128 MB heap cap** kept.

### You should enable (one toggle, huge idle savings)

Railway → service → **Settings → Serverless → Enable** (App Sleeping).  
Until that is on, the container stays warm and still uses background RAM.

## Auto-update

Unchanged: signed updates from GitHub Releases. Install 2.1.4 once; later versions update in-app.

## Upgrade

Library data under `Music/Prismatic` is preserved.
