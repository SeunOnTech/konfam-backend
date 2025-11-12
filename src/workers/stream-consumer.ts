/**
 * Konfam Stream Consumer
 * -------------------------
 * Listens to live X-Clone stream
 * Queues each incoming tweet for detection
 */

import { EventSource } from "eventsource";
import dotenv from "dotenv";
import { detectionQueue } from "../config/queue.js";

dotenv.config();

const STREAM_URL = process.env.XCLONE_STREAM_URL || "http://localhost:4000/api/stream/live";
console.log("🔗 Connecting to X Clone Stream:", STREAM_URL);

const es = new EventSource(STREAM_URL);

es.onopen = () => {
  console.log("✅ Connected to X-Clone live stream. Waiting for tweets...\n");
};

es.onmessage = async (event) => {
  try {
    const data = JSON.parse(event.data);
    const post = data.payload?.post;

    if (!post || !post.content) return;

    console.log(`🆕 New tweet queued: ${post.content.slice(0, 60)}...`);

    await detectionQueue.add("analyze-post", {
      externalPostId: post.id,
      platform: "X_CLONE",
      content: post.content,
      authorHandle: post.author?.username ?? "unknown",
      authorId: post.author?.id,
      likeCount: post.likeCount ?? 0,
      retweetCount: post.retweetCount ?? 0,
      replyCount: post.replyCount ?? 0,
      viewCount: post.viewCount ?? 0,
      postedAt: post.createdAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("💓 Heartbeat or parse error:", message);
  }
};

es.onerror = (err) => {
  console.error("⚠️ Stream connection error:", err);
};
