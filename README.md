# Prismatic

A lightweight music player for **Windows** and **macOS**. Built for everyday listening first — clean library, solid queue, and a cinematic Now Playing view when you want it. Transfer playlists offline with **Export zip** / **Import zip**.

<p align="center">
  <img src="docs/screenshots/library.jpg" alt="Prismatic library" width="900" />
</p>

## Highlights

- **Fast library** — songs, albums, artists, search, sort, virtualized rows
- **Persistent player** — keeps going while you browse, minimize, or switch tabs
- **Queue you control** — shuffle, repeat, reorder, resume after restart
- **Now Playing** — audio-reactive visuals without a heavy desktop runtime
- **Offline Studio** — export visuals on-device
- **Playlist zip** — export a set as a zip of audio files; import zip to forge a playlist
- **Desktop shell** — Tauri 2 on Windows/macOS (~2.5 MiB installer on Windows)
- **Auto-update** — signed updates from GitHub Releases (2.1.2+)

<p align="center">
  <img src="docs/screenshots/now-playing.jpg" alt="Prismatic Now Playing" width="900" />
</p>

## Download

Latest builds: **[GitHub Releases](https://github.com/Panther114/Prismatic/releases)**

| Platform | Package |
|---|---|
| Windows 10/11 x64 | `Prismatic_*_x64-setup.exe` |
| macOS 11+ (Apple Silicon) | `Prismatic_*_aarch64.dmg` |

Installers are **Authenticode-unsigned** for now — Windows may show SmartScreen. Prefer the `.sha256` checksums on the release.

**Auto-update (desktop 2.1.2+):** Settings → Software updates (or a quiet startup check). Builds older than 2.1.2 must install 2.1.2 once manually.

Your library lives at `Music/Prismatic` (plus a `.prismatic` state folder). Uninstalling the app does not wipe your music.

## Screenshots

| Library | Playlists |
|:---:|:---:|
| ![Library](docs/screenshots/library.jpg) | ![Playlists](docs/screenshots/playlists.jpg) |

| Now Playing | Studio |
|:---:|:---:|
| ![Now Playing](docs/screenshots/now-playing.jpg) | ![Studio](docs/screenshots/studio.jpg) |

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:4100
pnpm test
pnpm tauri:dev    # desktop shell
pnpm dist:win     # Windows NSIS + verify
```

Tag `v*` to run the [release workflow](.github/workflows/release.yml) (Windows + macOS + GitHub Release).

More detail: [ARCHITECTURE.md](ARCHITECTURE.md) · [RELEASE_NOTES.md](RELEASE_NOTES.md)

## License

Private project.
