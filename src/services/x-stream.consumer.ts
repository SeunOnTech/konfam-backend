/**
 * x-stream.consumer.ts
 * ------------------------------------------------------------
 * Listens to the X Clone backend's live stream (SSE)
 * and broadcasts incoming tweets to all Konfam WebSocket clients.
 * ------------------------------------------------------------
 */

import EventSource from "eventsource";
import { logger } from "../config/logger.js";
import type { WebSocketServer } from "ws";

const X_STREAM_URL = process.env.X_STREAM_URL || "http://localhost:5000/api/stream/live";

export class XStreamConsumer {
  private es: EventSource | null = null;
  private wss: WebSocketServer;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(wss: WebSocketServer) {
    this.wss = wss;
  }

  /** Start listening to the X Clone stream */
  start() {
    logger.info(`Connecting to X Clone Stream at ${X_STREAM_URL}`);
    this.es = new EventSource(X_STREAM_URL);

    this.es.onopen = () => {
      logger.info("✅ Connected to X Clone live stream");
    };

    this.es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        logger.info(`🔥 New tweet event from X Clone: ${data.type}`);

        // Broadcast to all WebSocket clients
        const message = JSON.stringify({ type: "tweet_stream", data });
        this.wss.clients.forEach((client) => {
          if (client.readyState === 1) {
            client.send(message);
          }
        });
      } catch (err) {
        logger.error("❌ Failed to parse stream event:", err);
      }
    };

    this.es.onerror = (err) => {
      logger.error("⚠️ Stream connection error:", err);
      this.reconnect();
    };
  }

  /** Try reconnecting if stream fails */
  private reconnect() {
    if (this.reconnectTimer) return;
    logger.warn("🔁 Attempting to reconnect to X Clone stream in 5s...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 5000);
  }

  stop() {
    if (this.es) {
      this.es.close();
      this.es = null;
      logger.info("🛑 Stopped consuming X Clone stream");
    }
  }
}
