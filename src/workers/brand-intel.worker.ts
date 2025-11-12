import { Worker } from "bullmq";
import { connection } from "../config/queue";
import dotenv from "dotenv";
import { BrandIntelligenceService } from "../services/brand-intelligence.service";

dotenv.config();

new Worker(
  "brand-intelligence",
  async (job) => {
    const { brandId, brandName } = job.data;
    const service = new BrandIntelligenceService(
      brandId,
      brandName,
      process.env.SERPAPI_API_KEY || ""
    );
    await service.run();
  },
  {
    connection,
    concurrency: 2,
  }
);

console.log("🚀 Brand Intelligence Worker is running...");
