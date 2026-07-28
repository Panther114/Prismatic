# Prismatic 2.1.3

## Bug fixes

- **Shuffle playlists** — starting a shuffled playlist no longer always opens on the first track; playback begins on a random item from the shuffled order.
- **Add to playlist menu** — the library “add to playlist” popover closes after you pick a playlist, when you click outside, press Escape, or scroll the list.

## Features

- **Playlist share (1-day code)** — share a playlist with a temporary 4-digit code. Another client can import the code to download original-quality audio (no re-encode), add tracks to their library, and forge the playlist automatically.
  - Limits (to keep Railway light): **≤ 25 tracks** and **under 100 minutes** total duration.
  - Packages expire after **24 hours**; tracks download **one at a time**.
  - Web/cloud uses same-origin `/api/playlist-share`. Desktop can use a Railway host via `localStorage.prismatic.shareApiBase`.
- **Edit playlist durations** — each track in the create/edit dialog shows its length.
- **Library bitrate** — each song row shows audio bitrate (kbps) to the left of the duration when known.

## Upgrade

Installing 2.1.3 preserves `%USERPROFILE%\Music\Prismatic` (and macOS `~/Music/Prismatic`) plus `.prismatic` state. Re-run the installer over an existing install is safe.
