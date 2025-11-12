// konfam-backend/src/config/queue.ts
/**
 * queue.ts — Central BullMQ Configuration (v5+)
 * ------------------------------------------------------------
 * - Centralized Redis connection
 * - Auto reconnects & graceful retry strategy
 * - Shared Queue setup for producers/workers
 * - Default job options tuned for reliability
 * ------------------------------------------------------------
 */

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

/* ------------------------------------------------------------
 * 🔹 Create Resilient Redis Connection
 * ------------------------------------------------------------ */
export const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  connectionName: "konfam-backend",
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    console.warn(`⏳ Redis retry attempt #${times} in ${delay}ms...`);
    return delay;
  },
  reconnectOnError: (err) => {
    console.error("🔁 Redis reconnect triggered due to error:", err.message);
    return true;
  },
});

connection.on("connect", () => {
  console.log("✅ Redis connected successfully.");
});

connection.on("error", (err) => {
  console.error("❌ Redis connection error:", err.message);
});

connection.on("close", () => {
  console.warn("⚠️ Redis connection closed. Retrying...");
});

/* ------------------------------------------------------------
 * 🔹 Main BullMQ Detection Queue
 * ------------------------------------------------------------ */
export const detectionQueue = new Queue("detection-jobs", {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 3000,
    },
  },
});

/* ------------------------------------------------------------
 * 🔹 Export Worker + Connection
 * ------------------------------------------------------------ */
export { Worker };
