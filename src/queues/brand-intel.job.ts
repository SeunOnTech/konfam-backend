import { Queue, Worker } from "bullmq";
import { connection } from "../config/queue.js";
import { BrandIntelligenceService } from "../services/brand-intelligence.service.js";

const brandIntelQueue = new Queue("brand-intelligence", {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
  },
});

// Schedule repeatable job every hour
await brandIntelQueue.add(
  "scrape-zenith",
  {},
  { repeat: { cron: "0 * * * *" } } // every hour
);

new Worker(
  "brand-intelligence",
  async () => {
    const scraper = new BrandIntelligenceService();
    await scraper.runScrapeCycle();
  },
  { connection }
);

console.log("🚀 Brand Intelligence Worker started — runs every hour.");
