/**
 * brand-intelligence.job.ts
 * ------------------------------------------------------------
 * BullMQ repeatable job for Brand Intelligence Scraper
 * Runs automatically every hour for all active brands.
 * ------------------------------------------------------------
 */

import { Queue, Worker } from "bullmq";
import { connection } from "../config/queue.js"; // reuse same Redis setup
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { BrandIntelligenceService } from "../services/brand-intelligence.service.js";

dotenv.config();
const prisma = new PrismaClient();

// ✅ Create queue
export const brandIntelQueue = new Queue("brand-intelligence", {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
  },
});

// ✅ Create worker (auto-start background)
export const brandIntelWorker = new Worker(
  "brand-intelligence",
  async (job) => {
    const { brandId, brandName } = job.data;
    console.log(`🧠 Running brand intelligence for ${brandName}...`);

    const service = new BrandIntelligenceService(
      brandId,
      brandName,
      process.env.SERPAPI_API_KEY || ""
    );
    await service.run();
  },
  { connection, concurrency: 1 }
);

// ✅ Schedule repeat job (every hour)
export async function scheduleBrandIntelJobs() {
  const brands = await prisma.brand.findMany({ where: { isActive: true } });

  for (const brand of brands) {
    await brandIntelQueue.add(
      "scrape-brand",
      { brandId: brand.id, brandName: brand.name },
      {
        repeat: { cron: "0 * * * *" }, // ⏰ every hour
        removeOnComplete: true,
      }
    );
    console.log(`⏳ Scheduled hourly scraper for ${brand.name}`);
  }
}

// Optional logging
brandIntelWorker.on("completed", (job) =>
  console.log(`✅ Brand scraping completed: ${job.data.brandName}`)
);

brandIntelWorker.on("failed", (job, err) =>
  console.error(`❌ Brand scr
