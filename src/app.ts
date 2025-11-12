/**
 * app.ts — Unified Konfam Backend Bootstrap (BullMQ v5+)
 * ------------------------------------------------------------
 * Starts:
 *  1. Express HTTP + WebSocket server
 *  2. Live X-Clone Stream consumer
 *  3. BullMQ Detection worker
 *  4. BullMQ Brand Intelligence worker (hourly)
 *  5. Graceful shutdown on exit
 * ------------------------------------------------------------
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { logger } from "./config/logger.js";
import { EventSource } from "eventsource";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { detectAndStorePost } from "./services/detection.service.js";
import { BrandIntelligenceService } from "./services/brand-intelligence.service.js";

dotenv.config();

/* ------------------------------------------------------------
 * EXPRESS + WEBSOCKET SERVER
 * ------------------------------------------------------------ */
const app = express();
app.use(express.json());

app.get("/", (_, res) => {
  res.json({ status: "Konfam backend running ✅" });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  logger.info("🔌 Client connected to Konfam WebSocket");
  ws.send(JSON.stringify({ message: "Welcome to Konfam Realtime!" }));
  ws.on("message", (msg) => logger.info(`Received WS message: ${msg}`));
  ws.on("close", () => logger.info("Client disconnected"));
});

/* ------------------------------------------------------------
 * REDIS / BULLMQ SETUP
 * ------------------------------------------------------------ */
const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const detectionQueue = new Queue("detection-jobs", { connection });

/* ------------------------------------------------------------
 * X-CLONE STREAM CONSUMER
 * ------------------------------------------------------------ */
const STREAM_URL =
  process.env.XCLONE_STREAM_URL || "http://localhost:4000/api/stream/live";
logger.info(`🔗 Connecting to X-Clone Stream: ${STREAM_URL}`);

let es: EventSource | null = null;

function startStreamConsumer() {
  es = new EventSource(STREAM_URL);

  es.onopen = () => logger.info("✅ Connected to X-Clone live stream.");
  es.onerror = (err: any) =>
    logger.error(`⚠️ Stream connection error: ${err?.message || err}`);

  es.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      const post = data.payload?.post || data.payload;
      if (!post || !(post.text || post.content)) return;

      const content = post.content || post.text;
      const author = post.user || post.author?.username || "unknown";

      logger.info(`🆕 Queued tweet: ${content.slice(0, 80)}...`);

      await detectionQueue.add("analyze-post", {
        externalPostId: post.id || crypto.randomUUID(),
        platform: "X_CLONE",
        content,
        authorHandle: author,
        authorId: post.author?.id || null,
        likeCount: post.likeCount ?? 0,
        retweetCount: post.retweetCount ?? 0,
        replyCount: post.replyCount ?? 0,
        viewCount: post.viewCount ?? 0,
        postedAt: post.createdAt || new Date().toISOString(),
      });
    } catch {
      // heartbeat or malformed JSON
    }
  };
}

/* ------------------------------------------------------------
 * DETECTION WORKER
 * ------------------------------------------------------------ */
let worker: Worker | null = null;
const prisma = new PrismaClient();

function startDetectionWorker() {
  worker = new Worker(
    "detection-jobs",
    async (job) => {
      const post = job.data;
      console.log(
        `\n🧠 [Job ${job.id}] Starting detection on: "${post.content.slice(0, 70)}..."`
      );

      const monitors = await prisma.monitor.findMany({
        where: { isActive: true },
        include: { brand: true },
      });

      if (!monitors.length) {
        console.log("⚠️ No monitors found — please seed one in the database.");
        return;
      }

      let anyMatched = false;

      for (const monitor of monitors) {
        const lower = post.content.toLowerCase();
        const matched = monitor.keywords.some((k) =>
          lower.includes(k.toLowerCase())
        );

        console.log(
          matched
            ? `✅ Matched monitor "${monitor.name}" [keywords: ${monitor.keywords.join(", ")}]`
            : `🚫 No match for monitor "${monitor.name}".`
        );

        if (!matched) continue;
        anyMatched = true;

        await detectAndStorePost({
          monitorId: monitor.id,
          brandId: monitor.brandId,
          externalPostId: post.externalPostId,
          platform: post.platform,
          content: post.content,
          authorHandle: post.authorHandle,
          authorId: post.authorId,
          likeCount: post.likeCount,
          retweetCount: post.retweetCount,
          replyCount: post.replyCount,
          viewCount: post.viewCount,
          postedAt: new Date(post.postedAt),
        });

        // Notify WebSocket clients
        wss.clients.forEach((client) => {
          client.send(
            JSON.stringify({
              event: "post_analyzed",
              data: {
                author: post.authorHandle,
                snippet: post.content.slice(0, 80),
              },
            })
          );
        });
      }

      if (!anyMatched)
        console.log("ℹ️ No monitors matched — skipping detailed detection.");

      console.log(`✅ Job ${job.id} fully processed.\n`);
      return { status: "done" };
    },
    { connection }
  );

  worker.on("completed", (job) =>
    logger.info(`🎯 Detection completed for job ${job.id}`)
  );
  worker.on("failed", (job, err) =>
    logger.error(`❌ Detection failed for job ${job?.id}: ${err.message}`)
  );
}

/* ------------------------------------------------------------
 * 🧠 BRAND INTELLIGENCE SCRAPER WORKER (hourly)
 * ------------------------------------------------------------ */
async function startBrandIntelWorker() {
  const brandIntelQueue = new Queue("brand-intelligence", { connection });

  // 🕒 Add repeatable hourly job
  await brandIntelQueue.add(
    "zenith-scrape",
    {},
    {
      repeat: { pattern: "0 * * * *" }, // ⏰ every hour
      removeOnComplete: true,
    }
  );

  // ⚡ Temporary: run immediately once on startup
//await brandIntelQueue.add("zenith-scrape-now", {}, { removeOnComplete: true });

  new Worker(
    "brand-intelligence",
    async () => {
      const scraper = new BrandIntelligenceService();
      await scraper.runScrapeCycle();
    },
    { connection }
  );

  console.log("🧠 Brand Intelligence Scraper Worker scheduled (every hour)");
}


/* ------------------------------------------------------------
 * GRACEFUL SHUTDOWN
 * ------------------------------------------------------------ */
async function gracefulShutdown(signal: string) {
  logger.warn(`🧹 ${signal} received. Shutting down gracefully...`);
  try {
    wss.clients.forEach((c) => c.close());
    wss.close();
    if (es) es.close();

    if (worker) await worker.close();
    await detectionQueue.close();
    await connection.quit();
    await prisma.$disconnect();

    server.close(() => {
      logger.info("✅ Server closed cleanly. Bye 👋");
      process.exit(0);
    });
  } catch (err: any) {
    logger.error(`⚠️ Error during shutdown: ${err.message}`);
    process.exit(1);
  }
}
["SIGINT", "SIGTERM"].forEach((s) => process.on(s, () => gracefulShutdown(s)));

/* ------------------------------------------------------------
 * APP STARTUP SEQUENCE
 * ------------------------------------------------------------ */
async function startServer() {
  try {
    startStreamConsumer();
    startDetectionWorker();
    startBrandIntelWorker(); // ✅ Added here

    const PORT = process.env.PORT || 4001;
    server.listen(PORT, () =>
      logger.info(`🚀 Konfam backend running on http://localhost:${PORT}`)
    );
  } catch (err: any) {
    logger.error(`❌ Server startup error: ${err.message}`);
    process.exit(1);
  }
}

startServer();
export { app, server };


// /**
//  * app.ts — Unified Konfam Backend Bootstrap (BullMQ v5+)
//  * ------------------------------------------------------------
//  * Starts:
//  *  1. Express HTTP + WebSocket server
//  *  2. Live X-Clone Stream consumer
//  *  3. BullMQ Detection worker (auto background)
//  *  4. Graceful shutdown on exit
//  * ------------------------------------------------------------
//  */

// import express from "express";
// import { createServer } from "http";
// import { WebSocketServer } from "ws";
// import dotenv from "dotenv";
// import { logger } from "./config/logger.js";
// import { EventSource } from "eventsource";
// import { Queue, Worker } from "bullmq";
// import IORedis from "ioredis";
// import { PrismaClient } from "@prisma/client";
// import { detectAndStorePost } from "./services/detection.service";


// dotenv.config();

// /* ------------------------------------------------------------
//  * INITIALIZE EXPRESS + WEBSOCKET SERVER
//  * ------------------------------------------------------------ */
// const app = express();
// app.use(express.json());

// app.get("/", (_, res) => {
//   res.json({ status: "Konfam backend running ✅" });
// });

// const server = createServer(app);
// const wss = new WebSocketServer({ server });

// wss.on("connection", (ws) => {
//   logger.info("🔌 Client connected to Konfam WebSocket");
//   ws.send(JSON.stringify({ message: "Welcome to Konfam Realtime!" }));
//   ws.on("message", (msg) => logger.info(`Received WS message: ${msg}`));
//   ws.on("close", () => logger.info("Client disconnected"));
// });

// /* ------------------------------------------------------------
//  * REDIS / BULLMQ SETUP
//  * ------------------------------------------------------------ */
// const connection = new IORedis(process.env.REDIS_URL!, {
//   maxRetriesPerRequest: null,
//   enableReadyCheck: false,
// });

// const detectionQueue = new Queue("detection-jobs", { connection });

// /* ------------------------------------------------------------
//  * X-CLONE STREAM CONSUMER
//  * ------------------------------------------------------------ */
// const STREAM_URL =
//   process.env.XCLONE_STREAM_URL || "http://localhost:4000/api/stream/live";
// logger.info(`🔗 Connecting to X-Clone Stream: ${STREAM_URL}`);

// let es: EventSource | null = null;

// function startStreamConsumer() {
//   es = new EventSource(STREAM_URL);

//   es.onopen = () => logger.info("✅ Connected to X-Clone live stream.");
//   es.onerror = (err: any) => {
//     logger.error(`⚠️ Stream connection error: ${err?.message || err}`);
//   };

// es.onmessage = async (event) => {
//   try {
//     const data = JSON.parse(event.data);

//     // Handle both payload shapes gracefully
//     const post = data.payload?.post || data.payload;

//     if (!post || !(post.text || post.content)) return;

//     const content = post.content || post.text;
//     const author = post.user || post.author?.username || "unknown";

//     logger.info(`🆕 Queued tweet: ${content.slice(0, 80)}...`);

//     await detectionQueue.add("analyze-post", {
//       externalPostId: post.id || crypto.randomUUID(),
//       platform: "X_CLONE",
//       content,
//       authorHandle: author,
//       authorId: post.author?.id || null,
//       likeCount: post.likeCount ?? 0,
//       retweetCount: post.retweetCount ?? 0,
//       replyCount: post.replyCount ?? 0,
//       viewCount: post.viewCount ?? 0,
//       postedAt: post.createdAt || new Date().toISOString(),
//     });
//   } catch (err) {
//     // likely a heartbeat message
//   }
// };

// }

// /* ------------------------------------------------------------
//  * DETECTION WORKER (BullMQ)
//  * ------------------------------------------------------------ */
// let worker: Worker | null = null;
// const prisma = new PrismaClient();

// function startDetectionWorker() {
//   worker = new Worker(
//     "detection-jobs",
//     async (job) => {
//       const post = job.data;
//       console.log(`\n🧠 [Job ${job.id}] Starting detection on: "${post.content.slice(0, 70)}..."`);

//       const monitors = await prisma.monitor.findMany({
//         where: { isActive: true },
//         include: { brand: true },
//       });

//       if (!monitors.length) {
//         console.log("⚠️ No monitors found — please seed one in the database.");
//         return;
//       }

//       let anyMatched = false;

//       for (const monitor of monitors) {
//         const lower = post.content.toLowerCase();
//         const matched = monitor.keywords.some((k) =>
//           lower.includes(k.toLowerCase())
//         );

//         console.log(
//           matched
//             ? `✅ Matched monitor "${monitor.name}" [keywords: ${monitor.keywords.join(", ")}]`
//             : `🚫 No match for monitor "${monitor.name}".`
//         );

//         if (!matched) continue;

//         anyMatched = true;

//         // Log that detection is starting
//         console.log(`🔍 Running full detection for monitor "${monitor.name}"...`);

//         await detectAndStorePost({
//           monitorId: monitor.id,
//           brandId: monitor.brandId,
//           externalPostId: post.externalPostId,
//           platform: post.platform,
//           content: post.content,
//           authorHandle: post.authorHandle,
//           authorId: post.authorId,
//           likeCount: post.likeCount,
//           retweetCount: post.retweetCount,
//           replyCount: post.replyCount,
//           viewCount: post.viewCount,
//           postedAt: new Date(post.postedAt),
//         });

//         // Notify WebSocket clients (still live)
//         wss.clients.forEach((client) => {
//           client.send(
//             JSON.stringify({
//               event: "post_analyzed",
//               data: {
//                 author: post.authorHandle,
//                 snippet: post.content.slice(0, 80),
//               },
//             })
//           );
//         });
//       }

//       if (!anyMatched) {
//         console.log("ℹ️ No monitors matched — skipping detailed detection.");
//       }

//       console.log(`✅ Job ${job.id} fully processed.\n`);
//       return { status: "done" };
//     },
//     { connection }
//   );

//   worker.on("completed", (job) => {
//     logger.info(`🎯 Detection completed for job ${job.id}`);
//   });

//   worker.on("failed", (job, err) => {
//     logger.error(`❌ Detection failed for job ${job?.id}: ${err.message}`);
//   });
// }


// /* ------------------------------------------------------------
//  * GRACEFUL SHUTDOWN HANDLER
//  * ------------------------------------------------------------ */
// async function gracefulShutdown(signal: string) {
//   logger.warn(`🧹 ${signal} received. Shutting down gracefully...`);

//   try {
//     // Close WebSocket
//     wss.clients.forEach((client) => client.close());
//     wss.close();

//     // Close EventSource
//     if (es) {
//       es.close();
//       logger.info("🛑 Stream consumer closed.");
//     }

//     // Stop worker and disconnect queue
//     if (worker) {
//       await worker.close();
//       logger.info("🛑 Worker closed.");
//     }

//     await detectionQueue.close();
//     await connection.quit();

//     await prisma.$disconnect();

//     server.close(() => {
//       logger.info("✅ Server closed cleanly. Bye 👋");
//       process.exit(0);
//     });
//   } catch (err: any) {
//     logger.error(`⚠️ Error during shutdown: ${err.message}`);
//     process.exit(1);
//   }
// }

// ["SIGINT", "SIGTERM"].forEach((signal) => {
//   process.on(signal, () => gracefulShutdown(signal));
// });

// /* ------------------------------------------------------------
//  * APP STARTUP SEQUENCE
//  * ------------------------------------------------------------ */
// async function startServer() {
//   try {
//     startStreamConsumer();
//     startDetectionWorker();

//     const PORT = process.env.PORT || 4001;
//     server.listen(PORT, () => {
//       logger.info(`🚀 Konfam backend running on http://localhost:${PORT}`);
//     });
//   } catch (err: any) {
//     logger.error(`❌ Server startup error: ${err.message}`);
//     process.exit(1);
//   }
// }

// startServer();

// export { app, server };
