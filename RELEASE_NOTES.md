# Prismatic 2.1.1

## Bug fixes

- **Taskbar pin / shortcuts:** Installer now writes Start Menu and Desktop shortcuts with an explicit icon path and `AppUserModelID` (`app.prismatic.desktop`), matching the running process so pins no longer show blank icons or spawn a second taskbar entry.
- **Windows app identity:** Packaged binary is `Prismatic.exe` with complete PE version metadata (`OriginalFilename`, `InternalName`, publisher, copyright).
- **Electron → Tauri cleanup:** Installer removes leftover Electron updater residue and Chromium profile caches under `%APPDATA%\Prismatic` without touching `%USERPROFILE%\Music\Prismatic`.
- **Re-import after remove:** Desktop re-imports unhide previously removed tracks so they reappear in the library.
- **Cover art cache:** Embedded artwork is refreshed when the image changes instead of keeping a stale cover forever.
- **Folder import depth:** Desktop folder scan depth matches the UI (0 = only files in the chosen folder).
- **Player preferences:** Compact player mode is restored after restart; prefs no longer race and overwrite disk settings on startup.
- **Remove while playing:** Removing the current track advances to the next queue item and continues playback when it was playing.
- **Library virtualization:** Song list measures its real viewport on mount and resize (no sparse rows until first scroll).
- **Clear library:** Desktop/local clear always hits the disk API; cloud mode only clears browser storage—no mixed wipe.
- **Playlists player chrome:** Bottom transport stays visible on Library and Playlists so starting a playlist shows immediate playback UI.

## Release notes

- Version **2.1.1** (Windows NSIS + macOS DMG via GitHub Actions when tagged).
- Installers remain **unsigned**. Windows may show SmartScreen until a code-signing certificate is configured. Verify downloads with the published `.sha256` checksums on the GitHub Release.

## Upgrade

Installing 2.1.1 preserves `%USERPROFILE%\Music\Prismatic` and `.prismatic` state. After upgrading, unpin any broken taskbar icon once and pin again from the Start Menu shortcut so Windows picks up the new AppUserModelID.
