# Prismatic 2.0.0

## Highlights

- Rebuilt the Windows desktop application on Tauri 2/WebView2.
- Fixed background and minimized playback by keeping audio alive while throttling visual work.
- Added OS Media Session controls and metadata.
- Added a persistent bottom player, queue editing, mini-player, and library-first navigation.
- Added Songs, Albums, Artists, search, sorting, virtualized rows, lazy covers, and improved empty/loading states.
- Added versioned queue/preferences and IndexedDB v2 lazy media storage.
- Reduced the Windows installer from 87.9 MiB to 2.54 MiB.

## Upgrade notes

Installing 2.0.0 preserves `%USERPROFILE%\Music\Prismatic` and `.prismatic` state. Track IDs and playlist JSON remain compatible with 1.2.0. The Tauri NSIS installer uses the same product name and a per-user install; obsolete Electron application files are replaced without touching the music library.

The installer is unsigned. Windows may show a reputation warning until a code-signing identity is supplied.

## Compatibility

Full desktop support targets modern Windows 10/11 x64. Full web support targets current Edge and Chrome; Firefox and Safari use progressive fallbacks. Mobile background playback, DRM, streaming services, CD ripping, and cloud music are not included.
