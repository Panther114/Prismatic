# Prismatic 2.1.6

## Fix: Share “Failed to fetch”

Desktop share was packing tracks with `fetch(asset://…)` which **WebView CSP blocks** — so share failed before reaching Railway.

- Read track bytes through a **Rust command** (`read_track_bytes`) instead of webview fetch.
- Allow `https://prismatic.up.railway.app` and asset hosts in CSP `connect-src`.
- Clearer errors when the share server is unreachable / still cold-starting.

## Share UI (2.1.5)

Immediate share dialog with progress, large code, and copy button.

## Upgrade

Install 2.1.6 over any previous build; library data is preserved.
