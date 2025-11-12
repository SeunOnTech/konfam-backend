/**
 * consume-stream.ts
 * ------------------------------------------------------------
 * Connects to /api/stream/live and logs every incoming tweet.
 * ------------------------------------------------------------
 */

import { EventSource } from "eventsource";


const STREAM_URL = "http://localhost:4000/api/stream/live";
console.log("🔗 Connecting to X Clone Stream:", STREAM_URL);

const es = new EventSource(STREAM_URL);

es.onopen = () => {
  console.log("✅ Connected to live stream. Waiting for tweets...\n");
};

es.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    console.log("🔥 New Tweet Event:");
    console.log(JSON.stringify(data, null, 2));
    console.log("--------------------------------------------------");
  } catch {
    console.log("💓 Heartbeat (connection alive)");
  }
};

es.onerror = (err) => {
  console.error("⚠️ Stream connection error:", err);
};
