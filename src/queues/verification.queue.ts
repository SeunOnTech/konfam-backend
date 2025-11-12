// src/queues/verification.queue.ts
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { handleThreatVerifyRespond, getWsBroadcaster } from "../services/verification-response.service";

export const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const verificationQueue = new Queue("verification-jobs", {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
  },
});

/**
 * 🕒 Periodic catch-up scanner
 */
export async function scheduleVerificationScanner() {
  await verificationQueue.add(
    "scan-unverified",
    {},
    { repeat: { every: 5 * 60 * 1000 }, removeOnComplete: true }
  );
  console.log("🕒 Verification scanner scheduled (every 5 mins)");
}

/**
 * 🧠 Core Verification Worker
 */
export const verificationWorker = new Worker(
  "verification-jobs",
  async (job) => {
    const broadcast = getWsBroadcaster();

    if (job.name === "scan-unverified") {
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();
      const pending = await prisma.threat.findMany({
        where: { verificationStatus: null },
        select: { id: true },
        take: 25,
      });

      console.log(`📋 Found ${pending.length} unverified threats to queue...`);
      for (const t of pending) {
        await verificationQueue.add("verify-one", { threatId: t.id, autopost: false });
      }

      await prisma.$disconnect();
      return { queued: pending.length };
    }

    if (job.name === "verify-one") {
      const { threatId, autopost } = job.data;
      console.log(`🔍 Running verification for threat: ${threatId}`);

      try {
        const result = await handleThreatVerifyRespond(threatId, !!autopost);

        if (result?.verified === true) {
          console.log(`✅ Threat ${threatId} verified as TRUE (no misinformation detected).`);
          broadcast?.("verification_complete", {
            threatId,
            status: "VERIFIED_TRUE",
            message: "✅ Verified as true information",
          });
        } else if (result?.verified === false) {
          console.log(`⚠️ Threat ${threatId} flagged as MISINFORMATION — response created.`);
          broadcast?.("verification_complete", {
            threatId,
            status: "MISINFORMATION",
            message: "⚠️ Misinformation detected — AI response generated",
          });
        } else {
          console.log(`ℹ️ Threat ${threatId} verification returned unknown result.`);
          broadcast?.("verification_complete", {
            threatId,
            status: "UNKNOWN",
            message: "ℹ️ Verification completed with no clear result",
          });
        }

        return { ok: true, result };
      } catch (err: any) {
        console.error(`❌ Verification failed for ${threatId}: ${err.message}`);
        broadcast?.("verification_failed", {
          threatId,
          status: "ERROR",
          message: `❌ Verification failed: ${err.message}`,
        });
        return { error: err.message };
      }
    }

    return { ok: true };
  },
  { connection }
);

/**
 * 🐂 Explicit starter for logs in app.ts
 */
export async function startVerificationWorker() {
  console.log("🐂 BullMQ Verification worker listening...");
}

// // src/queues/verification.queue.ts
// /**
//  * verification.queue.ts — Verification + AI Response Orchestrator
//  * ------------------------------------------------------------
//  * - Periodically scans unresolved threats
//  * - Verifies claims using trusted sources
//  * - Generates AI responses if misinformation detected
//  * - Optionally autoposts to X-Clone
//  * ------------------------------------------------------------
//  */

// import { Queue, Worker } from "bullmq";
// import IORedis from "ioredis";
// import { handleThreatVerifyRespond } from "../services/verification-response.service";

// export const connection = new IORedis(process.env.REDIS_URL!, {
//   maxRetriesPerRequest: null,
//   enableReadyCheck: false,
// });

// export const verificationQueue = new Queue("verification-jobs", {
//   connection,
//   defaultJobOptions: {
//     removeOnComplete: true,
//     attempts: 3,
//     backoff: { type: "exponential", delay: 3000 },
//   },
// });

// /**
//  * 🕒 Periodic catch-up scanner
//  * Runs every 5 minutes to queue unverified threats
//  */
// export async function scheduleVerificationScanner() {
//   await verificationQueue.add(
//     "scan-unverified",
//     {},
//     { repeat: { every: 5 * 60 * 1000 }, removeOnComplete: true } // every 5 minutes
//   );
//   console.log("🕒 Verification scanner scheduled (every 5 mins)");
// }

// /**
//  * 🧠 Core Verification Worker
//  */
// export const verificationWorker = new Worker(
//   "verification-jobs",
//   async (job) => {
//     if (job.name === "scan-unverified") {
//       const { PrismaClient } = await import("@prisma/client");
//       const prisma = new PrismaClient();
//       const pending = await prisma.threat.findMany({
//         where: { verificationStatus: null },
//         select: { id: true },
//         take: 25,
//       });

//       console.log(`📋 Found ${pending.length} unverified threats to queue...`);
//       for (const t of pending) {
//         await verificationQueue.add("verify-one", { threatId: t.id, autopost: false });
//       }

//       await prisma.$disconnect();
//       return { queued: pending.length };
//     }

//     if (job.name === "verify-one") {
//       const { threatId, autopost } = job.data;
//       console.log(`🔍 Running verification for threat: ${threatId}`);
//       return await handleThreatVerifyRespond(threatId, !!autopost);
//     }

//     return { ok: true };
//   },
//   { connection }
// );

// /**
//  * 🐂 Explicit starter to announce worker readiness
//  * (for app.ts logs)
//  */
// export async function startVerificationWorker() {
//   console.log("🐂 BullMQ Verification worker listening...");
// }
