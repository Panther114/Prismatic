# Prismatic 2.1.9

## Speed + freeze (share)

**2.1.7 felt frozen and ~30s per track.** Two separate problems:

| Issue | Cause | Fix |
|--------|--------|-----|
| **Freeze** | Blocking Rust share command held the UI thread | **2.1.8+**: background `spawn_blocking` + live progress events |
| **Slow download** | **Wake Railway on every track** + push each file through JS IPC twice | **2.1.9**: wake **once**; stream download **straight to library disk** |
| **Slow upload** | Load every MP3 into RAM and **clone** for multipart | **2.1.9**: stream with `Part::file` from disk |

## Also in 2.1.8+

- Edit/create playlist dialog above the player (Save not covered)
- Faster CI release builds

## Upgrade

Install **2.1.9**. Do not stay on 2.1.7 for share.
