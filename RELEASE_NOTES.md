# Prismatic 2.1.7

## Fix: Share stuck on “cold start — retry…”

Desktop was calling the Railway share API with **WebView `fetch`**, which keeps failing (`Failed to fetch` / endless cold-start retries) even when the server is healthy.

**Desktop share now uses native HTTP (Rust `reqwest`)**:

- Wake, upload, manifest lookup, and download all run outside the WebView
- Tracks are read from disk in Rust and multipart-uploaded directly
- Retries still handle Railway Serverless cold boots

## Upgrade

Install **2.1.7**. Library data is preserved. Prefer this over 2.1.5/2.1.6 for share.
