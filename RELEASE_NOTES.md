# Prismatic 2.1.15

## Now Playing, renewed

- **Audio-reactive stage** — the visible Now Playing view samples a small analyser and renders its low-resolution background at 12 fps while music plays. Paused playback holds a single frame, and the canvas stays idle outside that view.
- **Full-face record** — album art fills the spinning disc, with engraved grooves, a glassy highlight, and a larger center spindle hole.
- **Playlist controls** — search playlist tracks by title, artist, or album; sort by playlist order, title, artist, album, or duration in either direction.
- **Full-bleed missing art** — replaced the undersized note with a custom Prismatic cover tile across track and collection artwork.

## Upgrade

Install 2.1.15. Library under `Music/Prismatic` is preserved.

---

# Prismatic 2.1.14

## Library controls and queue fidelity

- **Compact sortable library table** — reclaim vertical space with column headers for song name, author, album, quality, and length. Click a header again to reverse its order; quality sorting handles both bits/s and kbps metadata.
- **Low-quality warning** — known bitrates below 320 kbps are highlighted in orange.
- **Reliable playlist menus** — Add to Playlist opens in a viewport-layered menu that flips above bottom rows and stays above the player.
- **Live upcoming queue** — the queue follows playlist edits, rename/reorder changes, repeat-all cycles, and repeat-one self-loops without showing stale past items. Manual queue edits remain stable across refreshes.
- **Safety and performance hardening** — guarded media paths against symlink escapes, made duplicate cleanup content-aware, serialized browser-library writes around deletes/clears, invalidated native waveform caches when files change, and avoided repeated empty-library scans.

## Upgrade

Install 2.1.14. Library under `Music/Prismatic` is preserved.

---

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
