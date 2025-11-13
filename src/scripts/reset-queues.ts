/**
 * reset-queues.ts
 * -------------------------------------------------------
 * Clears ALL BullMQ queues so the system starts fresh.
 * Includes: detection, verification, brand-intelligence.
 * -------------------------------------------------------
 */

import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

async function clearQueue(queue: Queue) {
  const name = queue.name;
  console.log(`\n🧹 Clearing queue: ${name}`);

  try {
    // Remove jobs in all states
    await queue.drain(true);
    await queue.clean(0, 0, "completed");
    await queue.clean(0, 0, "failed");
    await queue.clean(0, 0, "delayed");
    await queue.clean(0, 0, "wait");
    await queue.clean(0, 0, "active");

    // Remove repeatable jobs
    const repeatables = await queue.getRepeatableJobs();
    for (const job of repeatables) {
      await queue.removeRepeatableByKey(job.key);
    }

    console.log(`✔ Queue cleared: ${name}`);
  } catch (err: any) {
    console.error(`❌ Error clearing ${name}: ${err.message}`);
  }
}

async function main() {
  console.log("🚀 Starting queue reset...");

  const queues = [
    new Queue("detection-jobs", { connection }),
    new Queue("verification-jobs", { connection }),
    new Queue("brand-intelligence", { connection }),
  ];

  for (const q of queues) {
    await clearQueue(q);
  }

  await connection.quit();

  console.log("\n🎉 ALL QUEUES RESET SUCCESSFULLY!\n");
  process.exit(0);
}

main();
