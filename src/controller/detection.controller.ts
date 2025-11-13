import { Request, Response } from "express";
import { detectAndStorePost } from "../services/detection.service";

export async function analyzeIncomingPost(req: Request, res: Response) {
  try {
    const data = req.body;

    const result = await detectAndStorePost({
      monitorId: data.monitorId,
      brandId: data.brandId,
      externalPostId: data.externalPostId,
      platform: data.platform,
      content: data.content,
      authorHandle: data.authorHandle,
      authorId: data.authorId,
      likeCount: data.likeCount || 0,
      retweetCount: data.retweetCount || 0,
      replyCount: data.replyCount || 0,
      viewCount: data.viewCount || 0,
      postedAt: new Date(data.postedAt || Date.now()),
    });

    if (!result) {
      console.error("❌ Detection service returned null result");
      return res.status(500).json({ success: false, error: "Detection service returned no result" });
    }

    const flaggedResult = result as typeof result & { isFlagged?: boolean };

    return res.status(200).json({
      success: true,
      detectedPostId: result.id,
      message: flaggedResult.isFlagged
        ? "⚠️ Post flagged for potential threat."
        : "✅ Post analyzed — no threat detected.",
    });
  } catch (err: any) {
    console.error("❌ Detection failed:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
