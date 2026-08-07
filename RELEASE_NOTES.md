# Prismatic 2.1.13

## Quiet listening

Much lighter on CPU and RAM while music plays.

- **Frozen Now Playing backdrop during playback** — the visualizer draws a single static frame when a track starts and only animates while paused; Studio exports keep the full animation
- **No WebAudio graph while listening** — the analyser/recording graph is only built when Studio export needs it, so the WebRTC audio thread stays off during normal playback
- **Calmer UI clock** — time sync rides the native ~4 Hz event instead of re-rendering the whole app 60×/s
- Waveform memory cache capped (LRU) so long listening sessions stop accumulating

CPU while playing drops from ~8% to ~1%; RAM no longer grows with the waveform cache.

## Upgrade

Install 2.1.13. Library under `Music/Prismatic` is preserved.

---

# Prismatic 2.1.12

## Playlists, redesigned

The Playlists page is now a browsable collection instead of a dense list.

- **Tile grid** — each playlist is a big mosaic-artwork card (albums-style) with Play and Shuffle buttons that appear on the cover
- **Open a playlist** — click a card to see the songs inside; click any song to start playing it. **View all playlists** takes you back
- **Sidebar quick play** — every playlist in the left sidebar now has its own Play and Shuffle buttons
- Zip export, video export, edit, and delete moved into the playlist's song view

## Upgrade

Install 2.1.12. Library under `Music/Prismatic` is preserved.

---

# Prismatic 2.1.11

## Playlist zip transfer (replaces cloud share)

**No server required** for playlist transfer — no Railway, no share codes.

- **Archive (zip) icon** on a playlist → packs its audio into `{playlist name}.zip` (save dialog)
- **Import zip** → pick a zip; audio is added to your library and a playlist is forged from the **zip file name**

## Removed

- 4-digit cloud share / redeem code
- Share host uploads and related UI

## Upgrade

Install 2.1.11. Library under `Music/Prismatic` is preserved.
