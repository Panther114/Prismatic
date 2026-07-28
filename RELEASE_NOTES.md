# Prismatic 2.1.10

## Fix: share upload vs Railway 5‑minute body limit

Uploading an entire playlist in **one** multipart POST could not finish on typical home upload speeds before Railway (and Node’s default) cut the body at **5 minutes** — error:

`request or response body error for url (…/api/playlist-share)`

### New upload protocol (per track)

1. `POST /api/playlist-share/session` — metadata only  
2. `PUT /api/playlist-share/:code/tracks/:index` — **one** audio file per request  
3. `POST /api/playlist-share/:code/complete` — finalize for redeem  

Each track finishes well under the 5‑minute ceiling; large playlists no longer fail deterministically.

### Speed + UI

- Streams each file from disk (`Part::file`)
- Progress **bar** + percent + debug line (track index, bytes, elapsed)
- Share still runs off the UI thread (no freeze)
- Node `requestTimeout` disabled; heap raised to 192 MB on Railway

## Upgrade

Install **2.1.10**. Redeploy Railway so the new share API is live before sharing from the new desktop build.
