/**
 * Smoke-test per-track playlist share against production host.
 */
import http from "node:http";
import https from "node:https";

const BASE = process.env.PRISMATIC_SHARE_BASE || "https://prismatic.up.railway.app";

function request(method, path, {headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const lib = url.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 120_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks)});
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
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
      // cold
    }
    await new Promise((r) => setTimeout(r, 1200 + i * 400));
  }
  throw new Error("health wake failed");
}

function multipartOneFile(fields, fileField, fileName, fileBuf, contentType) {
  const boundary = "----PrismaticSmoke" + Date.now();
  const parts = [];
  const pushField = (name, value) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      "utf8",
    ));
  };
  for (const [k, v] of Object.entries(fields)) pushField(k, v);
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    "utf8",
  ));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
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
console.log("health ok", health.role || health.mode);

const sessionBody = JSON.stringify({
  name: "Smoke playlist",
  tracks: [{
    fileName: "smoke-track.mp3",
    title: "Smoke Track",
    artist: "Prismatic CI",
    album: "Smoke",
    duration: 30,
    bitrate: 128000,
    format: "MP3",
    contentType: "audio/mpeg",
  }],
});
const session = await request("POST", "/api/playlist-share/session", {
  headers: {"Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(sessionBody))},
  body: sessionBody,
});
if (session.status !== 201 && session.status !== 200) {
  console.error("session failed", session.status, session.body.toString("utf8"));
  process.exit(1);
}
const sessionJson = JSON.parse(session.body.toString("utf8"));
const code = sessionJson.code;
if (!/^\d{4}$/.test(code || "")) {
  console.error("bad session code", sessionJson);
  process.exit(1);
}
console.log("session code", code);

const fakeAudio = Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00SMOKE");
const {body, headers} = multipartOneFile(
  {meta: JSON.stringify({fileName: "smoke-track.mp3", title: "Smoke Track", contentType: "audio/mpeg"})},
  "audio",
  "smoke-track.mp3",
  fakeAudio,
  "audio/mpeg",
);
const put = await request("PUT", `/api/playlist-share/${code}/tracks/0`, {headers, body});
if (put.status < 200 || put.status >= 300) {
  console.error("put track failed", put.status, put.body.toString("utf8"));
  process.exit(1);
}
console.log("put track", put.body.toString("utf8").slice(0, 160));

const fin = await request("POST", `/api/playlist-share/${code}/complete`);
if (fin.status < 200 || fin.status >= 300) {
  console.error("complete failed", fin.status, fin.body.toString("utf8"));
  process.exit(1);
}
console.log("complete", fin.body.toString("utf8").slice(0, 160));

const manifestRes = await request("GET", `/api/playlist-share/${code}`);
if (manifestRes.status !== 200) {
  console.error("manifest failed", manifestRes.status, manifestRes.body.toString("utf8"));
  process.exit(1);
}
const manifest = JSON.parse(manifestRes.body.toString("utf8"));
if (!manifest.complete || !manifest.tracks?.length) {
  console.error("manifest incomplete", manifest);
  process.exit(1);
}

const dl = await request("GET", `/api/playlist-share/${code}/tracks/0`);
if (dl.status !== 200 || dl.body.length < 4) {
  console.error("download failed", dl.status, dl.body.length);
  process.exit(1);
}
console.log("download bytes", dl.body.length);
console.log("SMOKE_SHARE_OK");
