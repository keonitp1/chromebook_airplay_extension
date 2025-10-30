# AirPlay Audio Sender (Chromebook → Apple TV)

Audio streaming from a Chromebook to an Apple TV (including older generations).  
The Chrome extension provides the UI; a small Node backend serves HLS and asks the Apple TV to play it over AirPlay.

## How it works

- The extension starts/stops a local backend service at `http://localhost:8090`.
- The backend exposes an HLS playlist and segments (`/hls/stream.m3u8`) and uses AirPlay to play that URL.
- The extension captures system/tab audio (`getDisplayMedia({ audio: true })`), encodes it as WebM/Opus, and sends chunks to the backend over a WebSocket.
- ffmpeg transcodes the incoming audio to AAC/HLS on the fly.

## Requirements

- Node 18+
- ffmpeg available on PATH
- Apple TV on the same LAN (older gens are fine; they fetch the HLS URL)

## Setup

```bash
# Backend
cd backend
npm install
npm start
