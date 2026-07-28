/**
 * Smoke-test playlist share against production host.
 * Creates a tiny synthetic "audio" part and expects a 4-digit code.
 */
import https from "node:https";

const BASE = process.env.PRISMATIC_SHARE_BASE || "https://prismatic.up.railway.app";

function request(method, path, {headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 90_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({status: res.statusCode || 0, headers: res.headers, body: buf});
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function wake() {
  for (let i = 0; i < 10; i += 1) {
    try {
      const res = await request("GET", "/api/health");
      if (res.status === 200) {
        const json = JSON.parse(res.body.toString("utf8"));
        if (json.ok) return json;
      }
    } catch {
      // cold start
    }
    await new Promise((r) => setTimeout(r, 1500 + i * 500));
  }
  throw new Error("health wake failed");
}

function buildMultipart() {
  const boundary = "----PrismaticSmoke" + Date.now();
  const fakeAudio = Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00SMOKE"); // not real mp3; server stores bytes as-is
  const meta = [
    {
      fileName: "smoke-track.mp3",
      title: "Smoke Track",
      artist: "Prismatic CI",
      album: "Smoke",
      duration: 30,
      bitrate: 128000,
      format: "MP3",
      contentType: "audio/mpeg",
    },
  ];
  const parts = [];
  const push = (name, value, filename, type) => {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
    if (filename) head += `; filename="${filename}"`;
    head += "\r\n";
    if (type) head += `Content-Type: ${type}\r\n`;
    head += "\r\n";
    parts.push(Buffer.from(head, "utf8"));
    parts.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"));
    parts.push(Buffer.from("\r\n", "utf8"));
  };
  push("name", "Smoke playlist");
  push("tracks", JSON.stringify(meta));
  push("audio", fakeAudio, "smoke-track.mp3", "audio/mpeg");
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  const body = Buffer.concat(parts);
  return {
    body,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
  };
}

const health = await wake();
console.log("health ok", health.role || health.mode, health.sharePublicUrl || BASE);

const {body, headers} = buildMultipart();
const created = await request("POST", "/api/playlist-share", {headers, body});
const text = created.body.toString("utf8");
if (created.status !== 201 && created.status !== 200) {
  console.error("create failed", created.status, text);
  process.exit(1);
}
const json = JSON.parse(text);
if (!/^\d{4}$/.test(json.code || "")) {
  console.error("invalid code", json);
  process.exit(1);
}
console.log("created code", json.code, "expires", json.expiresAt);

const manifestRes = await request("GET", `/api/playlist-share/${json.code}`);
if (manifestRes.status !== 200) {
  console.error("manifest failed", manifestRes.status, manifestRes.body.toString("utf8"));
  process.exit(1);
}
const manifest = JSON.parse(manifestRes.body.toString("utf8"));
if (!manifest.tracks?.length) {
  console.error("manifest empty", manifest);
  process.exit(1);
}
console.log("manifest tracks", manifest.tracks.length);

const dl = await request("GET", `/api/playlist-share/${json.code}/tracks/0`);
if (dl.status !== 200 || dl.body.length < 4) {
  console.error("download failed", dl.status, dl.body.length);
  process.exit(1);
}
console.log("download bytes", dl.body.length);
console.log("SMOKE_SHARE_OK");
