# Prismatic 2.0 architecture

## Runtime boundary

React calls the typed `PlatformBackend` in `src/api.ts`. The browser backend retains the existing HTTP API and IndexedDB storage. The desktop backend invokes Tauri commands and converts only paths returned by the trusted Rust library scanner into scoped asset URLs.

The TypeScript server remains part of the web/Railway product. It is not bundled into the Windows installer.

## Desktop data

The Rust backend uses `%USERPROFILE%\Music\Prismatic` and preserves:

- `.prismatic/settings.json`
- `.prismatic/library.json`
- `.prismatic/playlists.json`
- `.prismatic/player.json`
- cached cover files
- SHA-1 track IDs derived as `sha1(sourceId:normalizedRelativePath).slice(0, 14)`

The default library source ID remains `music`; watched-folder IDs retain the previous SHA-1 path derivation.

## Playback lifecycle

The single `<audio>` element is owned by the root application and never unmounts during navigation. `visibilitychange` pauses only animation, canvas rendering, polling, and high-frequency time updates. Foregrounding resynchronizes UI state from `audio.currentTime`. Audio contexts are resumed only when playback is active and never suspended merely because the page is hidden.

The next item uses `preload="metadata"` so the player does not buffer or decode two tracks at once. Media Session handlers map OS/browser actions to the same queue.

## Browser persistence

IndexedDB version 2 separates `track-meta`, `track-audio`, and `track-cover`. Migration copies legacy inline records in one upgrade transaction, verifies the copied count, and only then clears legacy inline data. Startup reads metadata only; selected media and artwork are materialized lazily.

## Security

Tauri's asset protocol starts with the built-in library scope and dynamically adds only enabled watched folders. Symlink traversal is disabled during scanning. User-supplied track IDs resolve through the scanned library rather than being interpreted as paths.
