import {
  PrismaClient,
  ThreatSeverity,
  ThreatType,
  ThreatStatus,
  Platform,
  Threat,
} from "@prisma/client";
import Sentiment from "sentiment";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import { verificationQueue } from "../queues/verification.queue";

dotenv.config();

const prisma = new PrismaClient({ log: ["warn", "error"] });
const sentiment = new Sentiment();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

export async function detectAndStorePost(data: {
  monitorId: string;
  brandId: string;
  externalPostId: string;
  platform: keyof typeof Platform | string;
  content: string;
  authorHandle: string;
  authorId?: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  viewCount: number;
  postedAt: Date;
}): Promise<Threat | null> {  // 👈 now typed
  const { monitorId, brandId, content, authorHandle } = data;

  try {
    console.log(`\n🧠 [Detection] Starting analysis for @${authorHandle}: "${content.slice(0, 70)}..."`);

    // ------------------------------------------------------------
    // 1️⃣ Sentiment Analysis (Groq AI → fallback to local)
    // ------------------------------------------------------------
    let sentimentScore = 0;
    let sentimentTone = "NEUTRAL";
    let sentimentSummary = "Default neutral fallback.";

    try {
      const prompt = `
You are an AI sentiment analysis engine for brand reputation monitoring.
Analyze the following post and return a valid JSON exactly in this format:
{
  "sentimentScore": -0.8,
  "tone": "ANGER",
  "summary": "User is frustrated about Zenith Bank app downtime."
}

Text: """${content}"""
`;

      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: "You are a precise and concise sentiment analysis model." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      });

      const raw = response.choices[0]?.message?.content?.trim();
      if (!raw) throw new Error("Empty Groq response");

      const parsed = JSON.parse(raw);
      sentimentScore = Math.max(-1, Math.min(1, parsed.sentimentScore));
      sentimentTone = parsed.tone || "NEUTRAL";
      sentimentSummary = parsed.summary || "No summary provided.";

      console.log(`🤖 Groq Sentiment → ${sentimentScore.toFixed(2)} (${sentimentTone}) — ${sentimentSummary}`);
    } catch (err: any) {
      console.warn(`⚠️ Groq failed → fallback to local sentiment: ${err.message}`);

      const result = sentiment.analyze(content);
      sentimentScore = Math.max(-1, Math.min(1, result.comparative));
      sentimentTone =
        sentimentScore < -0.4
          ? "ANGER"
          : sentimentScore < -0.2
          ? "CONCERN"
          : sentimentScore < 0.2
          ? "NEUTRAL"
          : "POSITIVE";

      sentimentSummary = "Local sentiment fallback used (Groq unavailable).";
      console.log(`🧩 Local Sentiment → ${sentimentScore.toFixed(2)} (${sentimentTone})`);
    }

    // ------------------------------------------------------------
    // 2️⃣ Virality Estimation
    // ------------------------------------------------------------
    const totalEngagement = data.likeCount + data.retweetCount + data.replyCount;
    const engagementRate = data.viewCount > 0 ? totalEngagement / data.viewCount : 0;
    const viralScore = Math.min(100, engagementRate * 100 * (1 + data.retweetCount * 0.5));

    console.log(`📈 Virality → ${viralScore.toFixed(2)} | Engagement ${(engagementRate * 100).toFixed(1)}%`);

    // ------------------------------------------------------------
    // 3️⃣ Monitor Configuration
    // ------------------------------------------------------------
    const monitor = await prisma.monitor.findUnique({
      where: { id: monitorId },
      select: {
        id: true,
        name: true,
        keywords: true,
        sentimentThreshold: true,
        viralityThreshold: true,
      },
    });

    if (!monitor) {
      console.log(`⚠️ Monitor not found: ${monitorId}`);
      return null;
    }

    // ------------------------------------------------------------
    // 4️⃣ Trigger Conditions
    // ------------------------------------------------------------
    const lower = content.toLowerCase();
    const matchedKeywords = monitor.keywords.filter((kw) => lower.includes(kw.toLowerCase()));

    const sentimentTrigger = sentimentScore <= monitor.sentimentThreshold;
    const viralityTrigger = viralScore >= monitor.viralityThreshold;
    const keywordTrigger = matchedKeywords.length > 0;
    const triggered = sentimentTrigger || viralityTrigger || keywordTrigger;

    console.log(
      `🧠 Detection Check → sentiment=${sentimentScore.toFixed(2)} virality=${viralScore.toFixed(
        2
      )} keywords=${matchedKeywords.length}`
    );

    // ------------------------------------------------------------
    // 5️⃣ Save Detected Post
    // ------------------------------------------------------------
    const detectedPost = await prisma.detectedPost.upsert({
      where: {
        externalPostId_platform: {
          externalPostId: data.externalPostId,
          platform: data.platform as Platform,
        },
      },
      update: {
        content,
        sentimentPolarity: sentimentScore,
        viralScore,
        engagementRate,
        emotionalTone: sentimentTone,
        matchedKeywords,
        likeCount: data.likeCount,
        retweetCount: data.retweetCount,
        replyCount: data.replyCount,
        viewCount: data.viewCount,
        capturedAt: new Date(),
        isFlagged: triggered,
        flagReason: triggered
          ? `Triggered by ${
              sentimentTrigger
                ? "sentiment"
                : viralityTrigger
                ? "virality"
                : "keywords"
            }`
          : null,
      },
      create: {
        monitorId,
        brandId,
        externalPostId: data.externalPostId,
        platform: data.platform as Platform,
        content,
        authorHandle: data.authorHandle,
        authorId: data.authorId,
        likeCount: data.likeCount,
        retweetCount: data.retweetCount,
        replyCount: data.replyCount,
        viewCount: data.viewCount,
        viralScore,
        engagementRate,
        sentimentPolarity: sentimentScore,
        emotionalTone: sentimentTone,
        matchedKeywords,
        postedAt: new Date(data.postedAt),
        capturedAt: new Date(),
        isFlagged: triggered,
      },
    });

    // ------------------------------------------------------------
    // 6️⃣ Threat Creation (with Groq reasoning)
    // ------------------------------------------------------------
    let createdThreat: Threat | null = null;

    if (triggered) {
      const threatScore = Math.min(
        100,
        Math.abs(sentimentScore * 60) + viralScore * 0.8 + (keywordTrigger ? 10 : 0)
      );

      const severity: ThreatSeverity =
        threatScore >= 80
          ? "CRITICAL"
          : threatScore >= 60
          ? "HIGH"
          : threatScore >= 40
          ? "MEDIUM"
          : "LOW";

      const threatType: ThreatType =
        sentimentTrigger && keywordTrigger
          ? "NEGATIVE_SENTIMENT"
          : viralityTrigger
          ? "VIRAL_RISK"
          : "CRISIS";

      const reasons = [
        ...(matchedKeywords.length > 0 ? matchedKeywords : []),
        `${sentimentTone} tone detected`,
        sentimentSummary,
      ];

      createdThreat = await prisma.threat.upsert({
        where: { detectedPostId: detectedPost.id },
        update: {
          severity,
          threatType,
          threatScore,
          sentimentImpact: Math.abs(sentimentScore * 100),
          viralityImpact: viralScore,
          credibilityImpact: 50 + Math.random() * 30,
          analysisReasons: reasons,
          status: ThreatStatus.NEW,
        },
        create: {
          detectedPostId: detectedPost.id,
          brandId,
          monitorId,
          severity,
          threatType,
          status: ThreatStatus.NEW,
          threatScore,
          sentimentImpact: Math.abs(sentimentScore * 100),
          viralityImpact: viralScore,
          credibilityImpact: 50 + Math.random() * 30,
          analysisReasons: reasons,
          predictedReach: data.viewCount,
        },
      });

      // enqueue verification (step 3)
      await verificationQueue.add("verify-one", {
        threatId: createdThreat.id,
        autopost: false,
      });

      console.log(
        `🚨 Threat Created: [${severity}] ${threatType} (Score: ${threatScore.toFixed(
          1
        )}%) | Monitor: ${monitor.name}`
      );
      console.log(`💬 Reason → ${sentimentSummary}`);
    } else {
      console.log("✅ Post analyzed — no threat triggered.");
    }

    console.log(`✨ Done analyzing @${authorHandle}\n`);

    return createdThreat; // ✅ ensure this returns something usable
  } catch (err) {
    console.error("❌ Detection Error:", err);
    return null; // ensure predictable return type
  }
}

// /**
//  * detection.service.ts — Groq-powered NLP Detection
//  * ------------------------------------------------------------
//  * - Uses Groq for nuanced sentiment/tone/summary
//  * - Falls back to Sentiment.js locally if Groq fails
//  * - Stores Groq reasoning in Threat.analysisReasons
//  * ------------------------------------------------------------
//  */

// import {
//   PrismaClient,
//   ThreatSeverity,
//   ThreatType,
//   ThreatStatus,
//   Platform,
// } from "@prisma/client";
// import Sentiment from "sentiment";
// import Groq from "groq-sdk";
// import dotenv from "dotenv";
// import { verificationQueue } from "../queues/verification.queue";

// dotenv.config();

// const prisma = new PrismaClient({ log: ["warn", "error"] });
// const sentiment = new Sentiment();
// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// export async function detectAndStorePost(data: {
//   monitorId: string;
//   brandId: string;
//   externalPostId: string;
//   platform: keyof typeof Platform | string;
//   content: string;
//   authorHandle: string;
//   authorId?: string;
//   likeCount: number;
//   retweetCount: number;
//   replyCount: number;
//   viewCount: number;
//   postedAt: Date;
// }) {
//   const { monitorId, brandId, content, authorHandle } = data;

//   try {
//     console.log(`\n🧠 [Detection] Starting analysis for @${authorHandle}: "${content.slice(0, 70)}..."`);

//     // ------------------------------------------------------------
//     // 1️⃣ Sentiment Analysis (Groq AI → fallback to local)
//     // ------------------------------------------------------------
//     let sentimentScore = 0;
//     let sentimentTone = "NEUTRAL";
//     let sentimentSummary = "Default neutral fallback.";

//     try {
//       const prompt = `
// You are an AI sentiment analysis engine for brand reputation monitoring.
// Analyze the following post and return a valid JSON exactly in this format:
// {
//   "sentimentScore": -0.8,
//   "tone": "ANGER",
//   "summary": "User is frustrated about Zenith Bank app downtime."
// }

// Text: """${content}"""
// `;

//       const response = await groq.chat.completions.create({
//         model: "llama-3.3-70b-versatile",
//         messages: [
//           { role: "system", content: "You are a precise and concise sentiment analysis model." },
//           { role: "user", content: prompt },
//         ],
//         temperature: 0.2,
//       });

//       const raw = response.choices[0]?.message?.content?.trim();
//       if (!raw) throw new Error("Empty Groq response");

//       const parsed = JSON.parse(raw);
//       sentimentScore = Math.max(-1, Math.min(1, parsed.sentimentScore));
//       sentimentTone = parsed.tone || "NEUTRAL";
//       sentimentSummary = parsed.summary || "No summary provided.";

//       console.log(`🤖 Groq Sentiment → ${sentimentScore.toFixed(2)} (${sentimentTone}) — ${sentimentSummary}`);
//     } catch (err: any) {
//       console.warn(`⚠️ Groq failed → fallback to local sentiment: ${err.message}`);

//       const result = sentiment.analyze(content);
//       sentimentScore = Math.max(-1, Math.min(1, result.comparative));
//       sentimentTone =
//         sentimentScore < -0.4
//           ? "ANGER"
//           : sentimentScore < -0.2
//           ? "CONCERN"
//           : sentimentScore < 0.2
//           ? "NEUTRAL"
//           : "POSITIVE";

//       sentimentSummary = "Local sentiment fallback used (Groq unavailable).";
//       console.log(`🧩 Local Sentiment → ${sentimentScore.toFixed(2)} (${sentimentTone})`);
//     }

//     // ------------------------------------------------------------
//     // 2️⃣ Virality Estimation
//     // ------------------------------------------------------------
//     const totalEngagement = data.likeCount + data.retweetCount + data.replyCount;
//     const engagementRate = data.viewCount > 0 ? totalEngagement / data.viewCount : 0;
//     const viralScore = Math.min(100, engagementRate * 100 * (1 + data.retweetCount * 0.5));

//     console.log(`📈 Virality → ${viralScore.toFixed(2)} | Engagement ${(engagementRate * 100).toFixed(1)}%`);

//     // ------------------------------------------------------------
//     // 3️⃣ Monitor Configuration
//     // ------------------------------------------------------------
//     const monitor = await prisma.monitor.findUnique({
//       where: { id: monitorId },
//       select: {
//         id: true,
//         name: true,
//         keywords: true,
//         sentimentThreshold: true,
//         viralityThreshold: true,
//       },
//     });

//     if (!monitor) {
//       console.log(`⚠️ Monitor not found: ${monitorId}`);
//       return;
//     }

//     // ------------------------------------------------------------
//     // 4️⃣ Trigger Conditions
//     // ------------------------------------------------------------
//     const lower = content.toLowerCase();
//     const matchedKeywords = monitor.keywords.filter((kw) => lower.includes(kw.toLowerCase()));

//     const sentimentTrigger = sentimentScore <= monitor.sentimentThreshold;
//     const viralityTrigger = viralScore >= monitor.viralityThreshold;
//     const keywordTrigger = matchedKeywords.length > 0;
//     const triggered = sentimentTrigger || viralityTrigger || keywordTrigger;

//     console.log(
//       `🧠 Detection Check → sentiment=${sentimentScore.toFixed(2)} virality=${viralScore.toFixed(
//         2
//       )} keywords=${matchedKeywords.length}`
//     );

//     // ------------------------------------------------------------
//     // 5️⃣ Save Detected Post
//     // ------------------------------------------------------------
//     const detectedPost = await prisma.detectedPost.upsert({
//       where: {
//         externalPostId_platform: {
//           externalPostId: data.externalPostId,
//           platform: data.platform as Platform,
//         },
//       },
//       update: {
//         content,
//         sentimentPolarity: sentimentScore,
//         viralScore,
//         engagementRate,
//         emotionalTone: sentimentTone,
//         matchedKeywords,
//         likeCount: data.likeCount,
//         retweetCount: data.retweetCount,
//         replyCount: data.replyCount,
//         viewCount: data.viewCount,
//         capturedAt: new Date(),
//         isFlagged: triggered,
//         flagReason: triggered
//           ? `Triggered by ${
//               sentimentTrigger
//                 ? "sentiment"
//                 : viralityTrigger
//                 ? "virality"
//                 : "keywords"
//             }`
//           : null,
//       },
//       create: {
//         monitorId,
//         brandId,
//         externalPostId: data.externalPostId,
//         platform: data.platform as Platform,
//         content,
//         authorHandle: data.authorHandle,
//         authorId: data.authorId,
//         likeCount: data.likeCount,
//         retweetCount: data.retweetCount,
//         replyCount: data.replyCount,
//         viewCount: data.viewCount,
//         viralScore,
//         engagementRate,
//         sentimentPolarity: sentimentScore,
//         emotionalTone: sentimentTone,
//         matchedKeywords,
//         postedAt: new Date(data.postedAt),
//         capturedAt: new Date(),
//         isFlagged: triggered,
//       },
//     });

//     // ------------------------------------------------------------
//     // 6️⃣ Threat Creation (with Groq reasoning)
//     // ------------------------------------------------------------
//     if (triggered) {
//       const threatScore = Math.min(
//         100,
//         Math.abs(sentimentScore * 60) + viralScore * 0.8 + (keywordTrigger ? 10 : 0)
//       );

//       const severity: ThreatSeverity =
//         threatScore >= 80
//           ? "CRITICAL"
//           : threatScore >= 60
//           ? "HIGH"
//           : threatScore >= 40
//           ? "MEDIUM"
//           : "LOW";

//       const threatType: ThreatType =
//         sentimentTrigger && keywordTrigger
//           ? "NEGATIVE_SENTIMENT"
//           : viralityTrigger
//           ? "VIRAL_RISK"
//           : "CRISIS";

//       const reasons = [
//         ...(matchedKeywords.length > 0 ? matchedKeywords : []),
//         `${sentimentTone} tone detected`,
//         sentimentSummary,
//       ];

//       const createdThreat = await prisma.threat.upsert({
//         where: { detectedPostId: detectedPost.id },
//         update: {
//           severity,
//           threatType,
//           threatScore,
//           sentimentImpact: Math.abs(sentimentScore * 100),
//           viralityImpact: viralScore,
//           credibilityImpact: 50 + Math.random() * 30,
//           analysisReasons: reasons,
//           status: ThreatStatus.NEW,
//         },
//         create: {
//           detectedPostId: detectedPost.id,
//           brandId,
//           monitorId,
//           severity,
//           threatType,
//           status: ThreatStatus.NEW,
//           threatScore,
//           sentimentImpact: Math.abs(sentimentScore * 100),
//           viralityImpact: viralScore,
//           credibilityImpact: 50 + Math.random() * 30,
//           analysisReasons: reasons,
//           predictedReach: data.viewCount,
//         },
//       });

//       await verificationQueue.add("verify-one", { threatId: createdThreat.id, autopost: false });

//       console.log(
//         `🚨 Threat Created: [${severity}] ${threatType} (Score: ${threatScore.toFixed(
//           1
//         )}%) | Monitor: ${monitor.name}`
//       );
//       console.log(`💬 Reason → ${sentimentSummary}`);
//     } else {
//       console.log("✅ Post analyzed — no threat triggered.");
//     }

//     console.log(`✨ Done analyzing @${authorHandle}\n`);
//   } catch (err) {
//     console.error("❌ Detection Error:", err);
//   }
// }

// /**
//  * detection.service.ts — Hybrid NLP Detection (Groq + Local)
//  * ------------------------------------------------------------
//  * - Uses Groq for deep sentiment/tone reasoning
//  * - Falls back to local Sentiment.js if Groq unavailable
//  * - Stores result + creates Threats with dynamic scoring
//  * ------------------------------------------------------------
//  */

// import {
//   PrismaClient,
//   ThreatSeverity,
//   ThreatType,
//   ThreatStatus,
//   Platform,
// } from "@prisma/client";
// import Sentiment from "sentiment";
// import Groq from "groq-sdk";
// import dotenv from "dotenv";

// dotenv.config();

// const prisma = new PrismaClient({ log: ["warn", "error"] });
// const sentiment = new Sentiment();
// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// /**
//  * detectAndStorePost()
//  * ------------------------------------------------------------
//  * Analyzes sentiment, virality & keywords → stores detection,
//  * creates threat if triggered (with visible console output)
//  * ------------------------------------------------------------
//  */
// export async function detectAndStorePost(data: {
//   monitorId: string;
//   brandId: string;
//   externalPostId: string;
//   platform: keyof typeof Platform | string;
//   content: string;
//   authorHandle: string;
//   authorId?: string;
//   likeCount: number;
//   retweetCount: number;
//   replyCount: number;
//   viewCount: number;
//   postedAt: Date;
// }) {
//   const { monitorId, brandId, content, authorHandle } = data;

//   try {
//     console.log(`\n🧠 [Detection] Starting analysis for @${authorHandle}: "${content.slice(0, 70)}..."`);

//     // ------------------------------------------------------------
//     // 1️⃣ Sentiment Analysis (Groq AI → fallback to local)
//     // ------------------------------------------------------------
//     let sentimentScore = 0;
//     let sentimentTone = "NEUTRAL";
//     let sentimentSummary = "Default neutral fallback.";

//     try {
//       const prompt = `
// You are a brand sentiment and tone analysis engine.
// Analyze the following post and return a JSON like this exactly:
// {
//   "sentimentScore": -0.8,
//   "tone": "ANGER",
//   "summary": "User is upset with the bank for slow app performance."
// }

// Post: """${content}"""
// `;

//       const response = await groq.chat.completions.create({
//         model: "llama-3.3-70b-versatile",
//         messages: [
//           { role: "system", content: "You are a precise sentiment analysis engine." },
//           { role: "user", content: prompt },
//         ],
//         temperature: 0.2,
//       });

//       const raw = response.choices[0]?.message?.content?.trim();
//       if (raw) {
//         const parsed = JSON.parse(raw);
//         sentimentScore = Math.max(-1, Math.min(1, parsed.sentimentScore));
//         sentimentTone = parsed.tone ?? "NEUTRAL";
//         sentimentSummary = parsed.summary ?? "No summary provided.";
//         console.log(`🤖 Groq Sentiment → ${sentimentScore.toFixed(2)} (${sentimentTone}) — ${sentimentSummary}`);
//       } else {
//         throw new Error("Empty Groq response");
//       }
//     } catch (err: any) {
//       console.warn(`⚠️ Groq sentiment failed → fallback to local model: ${err.message}`);

//       const result = sentiment.analyze(content);
//       sentimentScore = Math.max(-1, Math.min(1, result.comparative));
//       sentimentTone =
//         sentimentScore < -0.4
//           ? "ANGER"
//           : sentimentScore < -0.2
//           ? "CONCERN"
//           : sentimentScore < 0.2
//           ? "NEUTRAL"
//           : "POSITIVE";

//       sentimentSummary = "Local sentiment analysis fallback used.";
//       console.log(`🧩 Local Sentiment → ${sentimentScore.toFixed(2)} (${sentimentTone})`);
//     }

//     // ------------------------------------------------------------
//     // 2️⃣ Virality Estimation
//     // ------------------------------------------------------------
//     const totalEngagement = data.likeCount + data.retweetCount + data.replyCount;
//     const engagementRate = data.viewCount > 0 ? totalEngagement / data.viewCount : 0;
//     const viralScore = Math.min(100, engagementRate * 100 * (1 + data.retweetCount * 0.5));

//     console.log(`📈 Virality → ${viralScore.toFixed(2)} | Engagement ${(engagementRate * 100).toFixed(1)}%`);

//     // ------------------------------------------------------------
//     // 3️⃣ Fetch Monitor Config
//     // ------------------------------------------------------------
//     const monitor = await prisma.monitor.findUnique({
//       where: { id: monitorId },
//       select: {
//         id: true,
//         keywords: true,
//         sentimentThreshold: true,
//         viralityThreshold: true,
//         name: true,
//       },
//     });

//     if (!monitor) {
//       console.log(`⚠️ Monitor not found: ${monitorId}`);
//       return;
//     }

//     // ------------------------------------------------------------
//     // 4️⃣ Triggers
//     // ------------------------------------------------------------
//     const lower = content.toLowerCase();
//     const matchedKeywords = monitor.keywords.filter((k) =>
//       lower.includes(k.toLowerCase())
//     );

//     const sentimentTrigger = sentimentScore <= monitor.sentimentThreshold;
//     const viralityTrigger = viralScore >= monitor.viralityThreshold;
//     const keywordTrigger = matchedKeywords.length > 0;
//     const triggered = sentimentTrigger || viralityTrigger || keywordTrigger;

//     console.log(
//       `🧩 Detection Check → sentiment=${sentimentScore.toFixed(2)} virality=${viralScore.toFixed(
//         2
//       )} keywords=${matchedKeywords.length}`
//     );

//     // ------------------------------------------------------------
//     // 5️⃣ Save Detected Post
//     // ------------------------------------------------------------
//     const detectedPost = await prisma.detectedPost.upsert({
//       where: {
//         externalPostId_platform: {
//           externalPostId: data.externalPostId,
//           platform: data.platform as Platform,
//         },
//       },
//       update: {
//         content,
//         sentimentPolarity: sentimentScore,
//         viralScore,
//         engagementRate,
//         emotionalTone: sentimentTone,
//         matchedKeywords,
//         likeCount: data.likeCount,
//         retweetCount: data.retweetCount,
//         replyCount: data.replyCount,
//         viewCount: data.viewCount,
//         capturedAt: new Date(),
//         isFlagged: triggered,
//         flagReason: triggered
//           ? `Triggered by ${
//               sentimentTrigger
//                 ? "sentiment"
//                 : viralityTrigger
//                 ? "virality"
//                 : "keywords"
//             }`
//           : null,
//       },
//       create: {
//         monitorId,
//         brandId,
//         externalPostId: data.externalPostId,
//         platform: data.platform as Platform,
//         content,
//         authorHandle: data.authorHandle,
//         authorId: data.authorId,
//         likeCount: data.likeCount,
//         retweetCount: data.retweetCount,
//         replyCount: data.replyCount,
//         viewCount: data.viewCount,
//         viralScore,
//         engagementRate,
//         sentimentPolarity: sentimentScore,
//         emotionalTone: sentimentTone,
//         matchedKeywords,
//         postedAt: new Date(data.postedAt),
//         capturedAt: new Date(),
//         isFlagged: triggered,
//       },
//     });

//     // ------------------------------------------------------------
//     // 6️⃣ Threat Creation (if triggered)
//     // ------------------------------------------------------------
//     if (triggered) {
//       const threatScore = Math.min(
//         100,
//         Math.abs(sentimentScore * 60) + viralScore * 0.8 + (keywordTrigger ? 10 : 0)
//       );

//       const severity: ThreatSeverity =
//         threatScore >= 80
//           ? "CRITICAL"
//           : threatScore >= 60
//           ? "HIGH"
//           : threatScore >= 40
//           ? "MEDIUM"
//           : "LOW";

//       const threatType: ThreatType =
//         sentimentTrigger && keywordTrigger
//           ? "NEGATIVE_SENTIMENT"
//           : viralityTrigger
//           ? "VIRAL_RISK"
//           : "CRISIS";

//       await prisma.threat.upsert({
//         where: { detectedPostId: detectedPost.id },
//         update: {
//           severity,
//           threatType,
//           threatScore,
//           sentimentImpact: Math.abs(sentimentScore * 100),
//           viralityImpact: viralScore,
//           credibilityImpact: 50 + Math.random() * 30,
//           analysisReasons:
//             matchedKeywords.length > 0
//               ? matchedKeywords
//               : [sentimentSummary],
//           status: ThreatStatus.NEW,
//         },
//         create: {
//           detectedPostId: detectedPost.id,
//           brandId,
//           monitorId,
//           severity,
//           threatType,
//           status: ThreatStatus.NEW,
//           threatScore,
//           sentimentImpact: Math.abs(sentimentScore * 100),
//           viralityImpact: viralScore,
//           credibilityImpact: 50 + Math.random() * 30,
//           analysisReasons:
//             matchedKeywords.length > 0 ? matchedKeywords : [sentimentSummary],
//           predictedReach: data.viewCount,
//         },
//       });

//       console.log(
//         `🚨 Threat Created: [${severity}] ${threatType} (Score: ${threatScore.toFixed(
//           1
//         )}%) | Monitor: ${monitor.name}`
//       );
//     } else {
//       console.log("✅ Post analyzed — no threat triggered.");
//     }

//     console.log(`✨ Done analyzing @${authorHandle}\n`);
//   } catch (err) {
//     console.error("❌ Detection Error:", err);
//   }
// }