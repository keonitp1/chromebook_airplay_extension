const BACKEND_URL = "http://localhost:8090";

const ipInput = document.getElementById("receiverIp");
const statusDiv = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

let ws = null;
let mediaRecorder = null;
let currentStream = null;

// Restore saved IP
document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["receiverIp"], ({ receiverIp }) => {
    if (receiverIp) ipInput.value = receiverIp;
  });
});

// Persist IP on change
ipInput.addEventListener("change", () => {
  chrome.storage.local.set({ receiverIp: ipInput.value.trim() });
});

startBtn.addEventListener("click", async () => {
  const ip = ipInput.value.trim();
  if (!ip) {
    setStatus("Enter Apple TV IP.");
    return;
  }

  setStatus("Starting…");

  try {
    // Ask backend to prepare HLS and start playback on Apple TV
    const resp = await fetch(`${BACKEND_URL}/start?ip=${encodeURIComponent(ip)}`);
    if (!resp.ok) {
      const errMsg = await safeJson(resp);
      setStatus(`Start failed: ${errMsg.message || resp.statusText}`);
      return;
    }
    const data = await resp.json();
    setStatus(data.message || "Ready. Sending audio…");

    // Capture audio and pipe to WS ingest
    await beginAudioIngest();
  } catch (err) {
    console.error(err);
    setStatus("Cannot reach backend. Is it running?");
  }
});

stopBtn.addEventListener("click", async () => {
  setStatus("Stopping…");
  endAudioIngest();

  try {
    const resp = await fetch(`${BACKEND_URL}/stop`);
    const data = await resp.json().catch(() => ({}));
    setStatus(data.message || "Stopped.");
  } catch {
    setStatus("Stopped.");
  }
});

function setStatus(msg) {
  statusDiv.textContent = msg;
}

async function safeJson(resp) {
  try { return await resp.json(); } catch { return {}; }
}

async function beginAudioIngest() {
  // Use getDisplayMedia for system/tab audio selection prompt
  // If Chrome denies audio capture, the user didn't grant it.
  currentStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });

  ws = new WebSocket("ws://localhost:8090/ingest");
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    mediaRecorder = new MediaRecorder(currentStream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 128000
    });

    mediaRecorder.ondataavailable = async (e) => {
      if (!e.data || e.data.size === 0) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      try {
        const buf = await e.data.arrayBuffer();
        ws.send(buf);
      } catch (err) {
        console.warn("send failed", err);
      }
    };

    mediaRecorder.start(250); // ~4 chunks/sec
    setStatus("Streaming audio…");
  };

  ws.onclose = () => {
    setStatus("Connection closed.");
  };

  ws.onerror = () => {
    setStatus("WebSocket error.");
  };
}

function endAudioIngest() {
  try { mediaRecorder && mediaRecorder.state !== "inactive" && mediaRecorder.stop(); } catch {}
  try { currentStream && currentStream.getTracks().forEach(t => t.stop()); } catch {}
  try { ws && ws.readyState === WebSocket.OPEN && ws.close(); } catch {}

  mediaRecorder = null;
  currentStream = null;
  ws = null;
}
