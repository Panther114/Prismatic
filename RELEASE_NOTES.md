# Prismatic 2.1.8

## Fixes

1. **Share no longer freezes the app** — packing/upload runs on a **background thread** with live progress events (`share-progress`). The share dialog keeps updating instead of going non-responsive during “Uploading…”.
2. **Edit/create playlist Save bar** — dialogs sit **above** the bottom player and leave bottom padding so **Save / Cancel** are never covered.
3. **Faster release builds** — CI no longer double-runs tests + full `pnpm check`; Rust uses **thin LTO** (was full LTO).

## Share reliability

Desktop share still uses **native Rust HTTP** to Railway (not WebView fetch), with cold-start wake + retries.

## Upgrade

Install 2.1.8. Library under `Music/Prismatic` is preserved.
