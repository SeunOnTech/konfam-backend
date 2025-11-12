// src/services/verification-response.service.ts
import { PrismaClient, ResponseStatus } from "@prisma/client";
import Groq from "groq-sdk";
import fetch from "node-fetch";

const prisma = new PrismaClient({ log: ["warn", "error"] });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

/** 🔌 WebSocket broadcast helper (plugged by app.ts) */
let wsBroadcast: ((event: string, payload: any) => void) | null = null;

export function bindWsBroadcaster(fn: (event: string, payload: any) => void) {
  wsBroadcast = fn;
}

export function getWsBroadcaster() {
  return wsBroadcast;
}

/** [3] Verify a threat using brand ScrapedItems */
export async function verifyThreat(threatId: string) {
  const threat = await prisma.threat.findUnique({
    where: { id: threatId },
    include: { detectedPost: true },
  });
  if (!threat) throw new Error("Threat not found");

  const claim = threat.detectedPost.content;
  const brandId = threat.brandId;
  const firstKeyword = claim.split(/\s+/).filter(Boolean)[0] ?? "";

  const scraped = await prisma.scrapedItem.findMany({
    where: {
      source: { brandId },
      OR: [
        { title: { contains: firstKeyword, mode: "insensitive" } },
        { content: { contains: firstKeyword, mode: "insensitive" } },
      ],
    },
    orderBy: [{ publishedAt: "desc" }, { credibility: "desc" }],
    take: 15,
  });

  const credible = scraped.filter((s) => (s.credibility ?? 0.5) >= 0.7);

  //let verificationStatus: "TRUE" | "FALSE" | "UNVERIFIED" = "UNVERIFIED";
  let verificationStatus = "UNVERIFIED";
  let verificationConfidence = 40;
  let verificationSummary = "No strong evidence found.";
  const evidenceIds = scraped.map((s) => s.id);

  if (scraped.length === 0) {
    verificationStatus = "UNVERIFIED";
    verificationConfidence = 35;
    verificationSummary = "No relevant coverage found among trusted sources.";
  } else if (credible.length === 0) {
    verificationStatus = "FALSE";
    verificationConfidence = 80;
    verificationSummary =
      "No trusted outlet confirms this claim; appears unsubstantiated.";
  } else {
    const headlines = credible
      .slice(0, 5)
      .map((s) => `- ${s.title ?? s.url}`)
      .join("\n");
    try {
      const judge = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You judge whether a social claim is confirmed by the listed sources. Return JSON only.",
          },
          {
            role: "user",
            content: `Claim: "${claim}"

Sources:
${headlines}

Return JSON:
{"verdict":"TRUE|FALSE|UNVERIFIED","confidence":0-100,"reason":"short"}
`,
          },
        ],
      });

      const raw = judge.choices[0]?.message?.content?.trim() ?? "";
      const parsed = JSON.parse(raw);
      verificationStatus = (parsed.verdict ?? "UNVERIFIED") as typeof verificationStatus;
      verificationConfidence = Math.max(
        0,
        Math.min(100, Number(parsed.confidence) || 60)
      );
      verificationSummary = parsed.reason || "LLM judge summary";
    } catch {
      verificationStatus = "UNVERIFIED";
      verificationConfidence = 60;
      verificationSummary = "Judge fallback";
    }
  }

  await prisma.threat.update({
    where: { id: threatId },
    data: {
      verificationStatus,
      verificationConfidence,
      verificationSummary,
      verificationEvidenceIds: evidenceIds,
    },
  });

  return { verificationStatus, verificationConfidence, verificationSummary, evidenceIds };
}

/** [4][5] Generate a confident response when claim is FALSE; store as PENDING */
export async function generateResponseForFalse(threatId: string) {
  const threat = await prisma.threat.findUnique({
    where: { id: threatId },
    include: { detectedPost: true, brand: true },
  });
  if (!threat) throw new Error("Threat not found");

  const claim = threat.detectedPost.content;
  const brandName = threat.brand.name;

  const evidence = await prisma.scrapedItem.findMany({
    where: { id: { in: threat.verificationEvidenceIds ?? [] } },
    orderBy: [{ credibility: "desc" }, { publishedAt: "desc" }],
    take: 3,
  });

  const sourcesBlock =
    evidence.length > 0
      ? evidence
          .map((s) => `• ${s.title ?? s.url} (${new URL(s.url).hostname})`)
          .join("\n")
      : "• No press references available yet.";

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "You write short, calm, factual brand corrections. No insults. No speculation.",
      },
      {
        role: "user",
        content: `Brand: ${brandName}
Claim (false): "${claim}"

Write a confident public correction (2–3 sentences). Include a 'Sources' block from the provided items, no fabrications.

Sources:
${sourcesBlock}

Return ONLY the final text.`,
      },
    ],
  });

  const content =
    completion.choices[0]?.message?.content?.trim() ||
    `${brandName}: This claim is incorrect. Operations remain normal.\n\nSources:\n${sourcesBlock}`;

  const sourcesUsed = evidence.map((s) => s.url);

  const response = await prisma.response.upsert({
    where: { threatId },
    update: {
      content,
      sourcesUsed,
      confidence: threat.verificationConfidence ?? 80,
      status: ResponseStatus.PENDING,
      autoGenerated: true,
    },
    create: {
      threatId,
      platform: threat.detectedPost.platform,
      content,
      sourcesUsed,
      confidence: threat.verificationConfidence ?? 80,
      status: ResponseStatus.PENDING,
      autoGenerated: true,
    },
  });

  console.log(`⚠️ AI Response generated for threat ${threatId}`);

  // 🔔 notify dashboard
  wsBroadcast?.("response_ready", {
    threatId,
    responseId: response.id,
    preview: content.slice(0, 240),
    confidence: response.confidence,
    sourcesUsed,
  });

  return response;
}

/** [6] Post to your X-clone; update status; notify dashboard */
export async function postResponseToXClone(responseId: string) {
  const response = await prisma.response.findUnique({
    where: { id: responseId },
    include: { threat: { include: { detectedPost: true } } },
  });
  if (!response) throw new Error("Response not found");

  const target = response.threat.detectedPost;
  const payload = {
    content: `@${target.authorHandle} ${response.content}`,
  };

  try {
    const res = await fetch(`${process.env.XCLONE_API_URL}/api/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.KONFAM_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`X-clone post failed: ${text}`);
    }

    await prisma.response.update({
      where: { id: responseId },
      data: { status: ResponseStatus.POSTED, postedAt: new Date() },
    });

    console.log(`✅ Response ${responseId} posted successfully.`);

    wsBroadcast?.("response_posted", {
      responseId,
      threatId: response.threatId,
      postedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    await prisma.response.update({
      where: { id: responseId },
      data: { status: ResponseStatus.FAILED },
    });

    console.error(`❌ Failed to post response ${responseId}: ${err.message}`);

    wsBroadcast?.("response_failed", {
      responseId,
      threatId: response.threatId,
      error: err.message,
    });

    throw err;
  }
}

/** [3–6] Orchestrator used by the worker */
export async function handleThreatVerifyRespond(threatId: string, autopost = false) {
  const { verificationStatus } = await verifyThreat(threatId);

  if (verificationStatus === "FALSE") {
    const resp = await generateResponseForFalse(threatId);
    if (autopost) await postResponseToXClone(resp.id);
    return { verified: false, action: "responded", responseId: resp.id };
  }

  if (verificationStatus === "TRUE") {
    wsBroadcast?.("verification_complete", {
      threatId,
      status: "VERIFIED_TRUE",
      message: "✅ Verified as true — no response needed",
    });
  } else {
    wsBroadcast?.("verification_complete", {
      threatId,
      status: "UNVERIFIED",
      message: "ℹ️ Could not verify with confidence",
    });
  }

  console.log(`✅ Threat ${threatId} verification finished → ${verificationStatus}`);
  return { verified: verificationStatus === "TRUE", action: "no_response_needed", status: verificationStatus };
}


// // src/services/verification-response.service.ts
// import { PrismaClient, ResponseStatus } from "@prisma/client";
// import Groq from "groq-sdk";
// import fetch from "node-fetch";

// const prisma = new PrismaClient({ log: ["warn", "error"] });
// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// /** Broadcast helper (plugged by app.ts) */
// let wsBroadcast: ((event: string, payload: any) => void) | null = null;
// export function bindWsBroadcaster(fn: (event: string, payload: any) => void) {
//   wsBroadcast = fn;
// }

// /** [3] Verify a threat using brand ScrapedItems */
// export async function verifyThreat(threatId: string) {
//   const threat = await prisma.threat.findUnique({
//     where: { id: threatId },
//     include: { detectedPost: true },
//   });
//   if (!threat) throw new Error("Threat not found");

//   const claim = threat.detectedPost.content;
//   const brandId = threat.brandId;
//   const firstKeyword = claim.split(/\s+/).filter(Boolean)[0] ?? "";

//   const scraped = await prisma.scrapedItem.findMany({
//     where: {
//       source: { brandId }, // relation filter through ScrapeSource.brandId
//       OR: [
//         { title:   { contains: firstKeyword, mode: "insensitive" } },
//         { content: { contains: firstKeyword, mode: "insensitive" } },
//       ],
//     },
//     orderBy: [{ publishedAt: "desc" }, { credibility: "desc" }],
//     take: 15,
//   });

//   const credible = scraped.filter(s => (s.credibility ?? 0.5) >= 0.7);

//   let verificationStatus: "TRUE" | "FALSE" | "UNVERIFIED" = "UNVERIFIED";
//   let verificationConfidence = 40;
//   let verificationSummary = "No strong evidence found.";
//   const evidenceIds = scraped.map(s => s.id);

//   if (scraped.length === 0) {
//     verificationStatus = "UNVERIFIED";
//     verificationConfidence = 35;
//     verificationSummary = "No relevant coverage found among trusted sources.";
//   } else if (credible.length === 0) {
//     verificationStatus = "FALSE";
//     verificationConfidence = 80;
//     verificationSummary = "No trusted outlet confirms this claim; appears unsubstantiated.";
//   } else {
//     // quick LLM judge to align claim with top credible sources
//     const headlines = credible.slice(0, 5).map(s => `- ${s.title ?? s.url}`).join("\n");
//     try {
//       const judge = await groq.chat.completions.create({
//         model: "llama-3.3-70b-versatile",
//         temperature: 0.2,
//         messages: [
//           { role: "system", content: "You judge whether a social claim is confirmed by the listed sources. Return JSON only." },
//           { role: "user", content:
// `Claim: "${claim}"

// Sources:
// ${headlines}

// Return JSON:
// {"verdict":"TRUE|FALSE|UNVERIFIED","confidence":0-100,"reason":"short"}
// ` },
//         ],
//       });

//       const raw = judge.choices[0]?.message?.content?.trim() ?? "";
//       const parsed = JSON.parse(raw);
//       verificationStatus = (parsed.verdict ?? "UNVERIFIED") as typeof verificationStatus;
//       verificationConfidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 60));
//       verificationSummary = parsed.reason || "LLM judge summary";
//     } catch {
//       verificationStatus = "UNVERIFIED";
//       verificationConfidence = 60;
//       verificationSummary = "Judge fallback";
//     }
//   }

//   await prisma.threat.update({
//     where: { id: threatId },
//     data: {
//       verificationStatus,
//       verificationConfidence,
//       verificationSummary,
//       verificationEvidenceIds: evidenceIds,
//     },
//   });

//   return { verificationStatus, verificationConfidence, verificationSummary, evidenceIds };
// }

// /** [4][5] Generate a confident response when claim is FALSE; store as PENDING */
// export async function generateResponseForFalse(threatId: string) {
//   const threat = await prisma.threat.findUnique({
//     where: { id: threatId },
//     include: { detectedPost: true, brand: true },
//   });
//   if (!threat) throw new Error("Threat not found");

//   const claim = threat.detectedPost.content;
//   const brandName = threat.brand.name;

//   const evidence = await prisma.scrapedItem.findMany({
//     where: { id: { in: threat.verificationEvidenceIds ?? [] } },
//     orderBy: [{ credibility: "desc" }, { publishedAt: "desc" }],
//     take: 3,
//   });

//   const sourcesBlock =
//     evidence.length > 0
//       ? evidence.map(s => `• ${s.title ?? s.url} (${new URL(s.url).hostname})`).join("\n")
//       : "• No press references available yet.";

//   const completion = await groq.chat.completions.create({
//     model: "llama-3.3-70b-versatile",
//     temperature: 0.3,
//     messages: [
//       { role: "system", content: "You write short, calm, factual brand corrections. No insults. No speculation." },
//       { role: "user", content:
// `Brand: ${brandName}
// Claim (false): "${claim}"

// Write a confident public correction (2–3 sentences). Include a 'Sources' block from the provided items, no fabrications.

// Sources:
// ${sourcesBlock}

// Return ONLY the final text.` },
//     ],
//   });

//   const content =
//     completion.choices[0]?.message?.content?.trim() ||
//     `${brandName}: This claim is incorrect. Operations remain normal.\n\nSources:\n${sourcesBlock}`;

//   const sourcesUsed = evidence.map(s => s.url);

//   const response = await prisma.response.upsert({
//     where: { threatId },
//     update: {
//       content,
//       sourcesUsed,
//       confidence: threat.verificationConfidence ?? 80,
//       status: ResponseStatus.PENDING,
//       autoGenerated: true,
//     },
//     create: {
//       threatId,
//       platform: threat.detectedPost.platform,
//       content,
//       sourcesUsed,
//       confidence: threat.verificationConfidence ?? 80,
//       status: ResponseStatus.PENDING,
//       autoGenerated: true,
//     },
//   });

//   // 🔔 notify dashboard that a response is ready for review
//   wsBroadcast?.("response_ready", {
//     threatId,
//     responseId: response.id,
//     preview: content.slice(0, 240),
//     confidence: response.confidence,
//     sourcesUsed,
//   });

//   return response;
// }

// /** [6] Post to your X-clone; update status; notify dashboard */
// export async function postResponseToXClone(responseId: string) {
//   const response = await prisma.response.findUnique({
//     where: { id: responseId },
//     include: { threat: { include: { detectedPost: true } } },
//   });
//   if (!response) throw new Error("Response not found");

//   const target = response.threat.detectedPost;
//   const payload = {
//     content: `@${target.authorHandle} ${response.content}`,
//   };

//   try {
//     const res = await fetch(`${process.env.XCLONE_API_URL}/api/posts`, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         Authorization: `Bearer ${process.env.KONFAM_API_KEY}`,
//       },
//       body: JSON.stringify(payload),
//     });

//     if (!res.ok) {
//       const text = await res.text();
//       throw new Error(`X-clone post failed: ${text}`);
//     }

//     await prisma.response.update({
//       where: { id: responseId },
//       data: { status: ResponseStatus.POSTED, postedAt: new Date() },
//     });

//     // 🔔 notify dashboard that the response was posted
//     wsBroadcast?.("response_posted", {
//       responseId,
//       threatId: response.threatId,
//       postedAt: new Date().toISOString(),
//     });
//   } catch (err: any) {
//     await prisma.response.update({
//       where: { id: responseId },
//       data: { status: ResponseStatus.FAILED },
//     });

//     // 🔔 notify dashboard failure
//     wsBroadcast?.("response_failed", {
//       responseId,
//       threatId: response.threatId,
//       error: err.message,
//     });

//     throw err;
//   }
// }

// /** One-call orchestrator used by the worker */
// export async function handleThreatVerifyRespond(threatId: string, autopost = false) {
//   const { verificationStatus } = await verifyThreat(threatId);

//   if (verificationStatus === "FALSE") {
//     const resp = await generateResponseForFalse(threatId);
//     if (autopost) {
//       await postResponseToXClone(resp.id);
//     }
//     return { action: "responded", responseId: resp.id };
//   }

//   return { action: "no_response_needed", status: verificationStatus };
// }
