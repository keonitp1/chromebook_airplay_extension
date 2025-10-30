import express from "express";
import http from "http";
import cors from "cors";
import morgan from "morgan";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import ip from "ip";
import AirPlay from "airplay-js";

const PORT = process.env.PORT || 8090;
const HLS_DIR = path.resolve("./hls");
const HLS_PLAYLIST = path.join(HLS_DIR, "stream.m3u8");

fs.mkdirSync(HLS_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(morgan("tiny"));
app.use("/hls", express.static(HLS_DIR, { fallthrough: false }));

let ffmpegProc = null;
let airplayDevice = null;
let currentAppleTvIp = null;

/**
 * Start ffmpeg to transcode incoming webm/opus (stdin) to HLS/AAC in ./hls
 */
function startTranscoder() {
  if (ffmpegProc) return;

  // Remove old segments and playlist
  for (const f of fs.readdirSync(HLS_DIR)) {
    fs.rmSync(path.join(HLS_DIR, f));
  }

  ffmpegProc = spawn("ffmpeg", [
    "-loglevel", "warning",
    "-re",
    "-i", "pipe:0",
    "-vn",
    "-acodec", "aac",
    "-ac", "2",
    "-ar", "48000",
    "-b:a", "160k",
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "6",
    "-hls_flags", "delete_segments+append_list+independent_segments",
    HLS_PLAYLIST
  ], { stdio: ["pipe", "inherit", "inherit"] });

  ffmpegProc.on("exit", (code, sig) => {
    console.log(`[ffmpeg] exited code=${code} sig=${sig}`);
    ffmpegProc = null;
  });
}

function stopTranscoder() {
  if (ffmpegProc) {
    try { ffmpegProc.stdin.end(); } catch {}
    try { ffmpegProc.kill("SIGTERM"); } catch {}
    ffmpegProc = null;
  }
}

/**
 * Discover Apple TV devices and trigger playback on the one with the given IP.
 * Old Apple TV models accept "play this URL" and fetch the HLS stream directly.
 */
function playOnAppleTv(targetIp, mediaUrl) {
  return new Promise((resolve, reject) => {
    const browser = AirPlay.createBrowser();
    let done = false;

    const close = (err) => {
      if (done) return;
      done = true;
      try { browser.stop(); } catch {}
      err ? reject(err) : resolve();
    };

    browser.on("deviceOn", (device) => {
      if (!device || !device.info) return;
      if (device.info.address === targetIp) {
        airplayDevice = device;
        device.play(mediaUrl, 0, (err) => close(err || null));
      }
    });

    browser.on("error", (e) => {
      // Device discovery sometimes emits non-fatal noise; ignore unless unresolved
      if (!done) console.warn("[airplay] browse error:", e.message || e);
    });

    browser.start();

    // Give discovery a bounded window
    setTimeout(() => {
      if (!done && !airplayDevice) close(new Error("Apple TV not found on the LAN."));
    }, 6000);
  });
}

function stopAppleTv() {
  return new Promise((resolve) => {
    if (!airplayDevice) return resolve();
    try {
      airplayDevice.stop(() => {
        airplayDevice = null;
        resolve();
      });
    } catch {
      airplayDevice = null;
      resolve();
    }
  });
}

// Routes

app.get("/start", async (req, res) => {
  const ipParam = (req.query.ip || "").trim();
  if (!ipParam) return res.status(400).json({ message: "Missing ?ip=" });

  currentAppleTvIp = ipParam;
  startTranscoder();

  const hostIp = ip.address();
  const hlsUrl = `http://${hostIp}:${PORT}/hls/stream.m3u8`;

  try {
    await playOnAppleTv(currentAppleTvIp, hlsUrl);
    return res.json({ message: `Ready. Apple TV is loading ${hlsUrl}. Begin sending audio.` });
  } catch (e) {
    console.error("AirPlay error:", e);
    return res.status(500).json({ message: "AirPlay start failed." });
  }
});

app.get("/stop", async (_req, res) => {
  await stopAppleTv();
  stopTranscoder();
  return res.json({ message: "Stopped." });
});

app.get("/healthz", (_req, res) => {
  res.json({
    appleTvIp: currentAppleTvIp || null,
    playlist: fs.existsSync(HLS_PLAYLIST),
    ffmpeg: !!ffmpegProc
  });
});

// WebSocket for ingesting audio chunks (webm/opus)
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ingest" });

wss.on("connection", (ws) => {
  console.log("[ws] ingest connected");
  if (!ffmpegProc) startTranscoder();

  ws.on("message", (chunk) => {
    if (ffmpegProc && ffmpegProc.stdin.writable && chunk && chunk.length) {
      ffmpegProc.stdin.write(chunk);
    }
  });

  ws.on("close", () => {
    console.log("[ws] ingest closed");
  });
});

server.listen(PORT, () => {
  console.log(`Backend on http://localhost:${PORT}`);
  console.log(`HLS at http://${ip.address()}:${PORT}/hls/stream.m3u8`);
});
