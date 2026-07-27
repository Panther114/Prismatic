# Prismatic 2.0

Prismatic is a lightweight, listening-first music player for Windows and the web. It combines a fast everyday library and persistent queue with a cinematic audio-reactive Now Playing view and offline video export Studio.

## What changed in 2.0

- Tauri 2 replaces Electron on Windows and uses the operating system's WebView2 runtime.
- Playback lives in one persistent player and continues while navigating, minimized, obscured, or in a background browser tab.
- Media Session metadata and play, pause, previous, next, and seek actions integrate with supported OS/browser media controls.
- Library-first navigation includes Songs, Albums, Artists, search, sorting, lazy covers, and virtualized song rows.
- The editable queue, shuffle/repeat state, player preferences, and library view restore after restart.
- Browser IndexedDB v2 hydrates metadata only and loads audio blobs and covers on demand.

Prismatic preserves `%USERPROFILE%\Music\Prismatic`, its `.prismatic` state directory, playlist JSON, settings, metadata overrides, and the existing SHA-1-derived track IDs.

## Requirements

- Windows 10/11 x64 for the desktop app
- Microsoft Edge WebView2 Runtime (normally already present; the installer downloads its bootstrapper only when required)
- Current Edge or Chrome for full web functionality
- Node.js 20.19+ and Rust stable MSVC to build from source

The release installer is currently unsigned.

## Development

```bash
pnpm install
pnpm dev                 # web/local server at http://localhost:4100
pnpm test
pnpm check
pnpm tauri:dev           # Windows desktop shell
pnpm dist:win            # release NSIS installer + verification
```

The public Railway deployment remains supported:

```bash
pnpm build
pnpm build:server
pnpm start
```

## Architecture

| Layer | Responsibility |
|---|---|
| React/Vite | Library, playlists, persistent player/queue, Now Playing, and Studio |
| `PlatformBackend` | Stable typed boundary selecting browser HTTP/IndexedDB or Tauri commands |
| Tauri/Rust | Desktop library scan, metadata/covers, imports, watched folders, playlists, preferences, scoped media paths, and output locations |
| TypeScript server | Railway/web deployment and optional local-server library APIs |
| IndexedDB v2 | Separate metadata, audio blob, cover, and state records with lazy hydration |

See [ARCHITECTURE.md](ARCHITECTURE.md) for runtime and persistence details and [RELEASE_NOTES.md](RELEASE_NOTES.md) for migration notes.

## Performance

Measured on the same Windows development machine:

| Metric | 1.2.0 Electron baseline | 2.0.0 Tauri build |
|---|---:|---:|
| Installer | 87.9 MiB | 2.54 MiB |
| Packaged executable | Electron runtime included | 6.14 MiB |
| Hidden idle private working set | ~265.5 MiB private baseline | ~194.3 MiB across app + WebView2 |
| Hidden background CPU | not previously gated | ~0.1% over 30 seconds |

The final installer is ~2.54 MiB and the installed Prismatic files are ~6.2 MiB. Windows' ordinary working-set counters double-count shared WebView2 code pages across its sandboxed processes (about 476 MiB summed in this measurement), so the private working set is the comparable application-memory figure. The shared OS WebView2 runtime is excluded from Prismatic's installed size. Visualization animation and playback-time rendering stop when hidden; audio output does not.

## Data safety

- Removing a track from the library does not delete it unless disk deletion is explicitly chosen.
- Uninstalling Prismatic does not remove the user's music library or `.prismatic` state.
- Desktop asset access is scoped to the built-in music library, cached covers, and explicitly watched folders.
- Listening playback uses the browser/OS decoder without normalization or transcoding.

## License

Private project.
