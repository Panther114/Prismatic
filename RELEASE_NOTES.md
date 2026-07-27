# Prismatic 2.1.0

## Highlights

- Added a collapsible desktop sidebar and reclaimed the full workspace in focused views.
- Made library songs play on a single click and improved the Space playback shortcut.
- Rebuilt playlist creation and editing around fast click-to-toggle membership with reorder support.
- Dramatically increased library and playlist density with smaller artwork, compact controls, and more visible rows.
- Replaced track overflow menus with direct add-to-playlist and remove buttons.
- Added custom dropdowns, custom seek/volume sliders, and high-contrast missing-art placeholders.
- Added a confirmed Clear Library reset and hardened deletion so imported or watched source files outside Prismatic are never touched.
- Hidden the bottom player outside Library and Now Playing so Studio, Settings, and Playlists use the full window.

## Upgrade notes

Installing 2.1.0 preserves the existing `%USERPROFILE%\Music\Prismatic` library and `.prismatic` state. Track IDs, playlists, queue state, and player preferences remain compatible with 2.0.0.

The installer is unsigned. Windows may show a reputation warning until a code-signing identity is supplied.

## Compatibility

Full desktop support targets modern Windows 10/11 x64. Full web support targets current Edge and Chrome; Firefox and Safari use progressive fallbacks.
