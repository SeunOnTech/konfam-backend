import { Worker } from "../config/queue.js";
import { detectAndStorePost } from "../services/detection.service.js";
import { PrismaClient } from "@prisma/client";
import { logger } from "../config/logger.js";

const prisma = new PrismaClient();

const detectionWorker = new Worker(
  "detection-jobs",
  async (job) => {
    const post = job.data;

    // Find active monitors for relevant brands
    const monitors = await prisma.monitor.findMany({
      where: { isActive: true },
      include: { brand: true },
    });

    for (const monitor of monitors) {
      const lower = post.content.toLowerCase();
      if (!monitor.keywords.some((k) => lower.includes(k.toLowerCase()))) continue;

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
    }

    return { status: "done" };
  },
  { connection: prisma as any }
);

detectionWorker.on("completed", (job) =>
  logger.info(`✅ Detection completed for ${job.id}`)
);
detectionWorker.on("failed", (job, err) =>
  logger.error(`❌ Job ${job?.id} failed: ${err.message}`)
);
