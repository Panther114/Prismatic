# Prismatic 2.1.2

## New: signed auto-update

- **In-app updates** for the desktop app (Windows + macOS). Prismatic checks GitHub Releases for a newer version, shows a dedicated update UI, downloads a **signed** package, verifies it with the embedded public key, then installs and relaunches.
- **Settings → Software updates** — manual “Check for updates” and install controls.
- **Quiet startup check** (every 6 hours at most). Never installs without your confirmation in the update dialog.
- **Release manifest** — each GitHub Release includes `latest.json` plus `.sig` files used by the Tauri updater.

## Notes

- Installers remain **Authenticode-unsigned**, so Windows SmartScreen may still appear on first download. That is separate from updater signing (minisign), which protects the update channel.
- **Older builds (≤ 2.1.1) cannot auto-update.** Install 2.1.2 once manually; from then on, 2.1.2+ can update themselves.

## Upgrade

Installing 2.1.2 preserves `%USERPROFILE%\Music\Prismatic` (and macOS `~/Music/Prismatic`) plus `.prismatic` state. Re-run the installer over an existing install is safe; no library wipe.
