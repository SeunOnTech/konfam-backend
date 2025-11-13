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

  const sourcesUsed = evidence.map((s) => s.url);

  // 🔹 Build "Verified Sources" section (HTML)
  const verifiedSourcesHTML =
    sourcesUsed.length > 0
      ? `<ul>${sourcesUsed
          .map((src) => `<li><a href="${src}" target="_blank">${src}</a></li>`)
          .join("")}</ul>`
      : "<p>No verified press sources available yet.</p>";

  // 🔹 LLM prompt WITHOUT sources
  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Write a short, calm, factual brand correction (2–3 sentences). No insults. No speculation. Do NOT include sources. Return plain text only.",
      },
      {
        role: "user",
        content: `Brand: ${brandName}
Claim: "${claim}"

Write a concise correction that clearly states the claim is false. No more than 450 characters. Return *only* the correction text.`,
      },
    ],
  });

  let rawContent =
    completion.choices[0]?.message?.content?.trim() ||
    `${brandName}: This claim is incorrect. Operations remain normal.`;

  // 🔹 Enforce max character limit ~580
  if (rawContent.length > 580) {
    rawContent = rawContent.slice(0, 580) + "…";
  }

  // 🔹 Convert to HTML and append footer + verified sources
  const htmlContent = `
<p>${rawContent}</p>

<br/>

<p>
  For instant support, please chat with 
  <span style="color:#007bff;font-weight:600;">Zenith Bank’s official assistant, ZiVA</span>,
  on WhatsApp at 
  <a href="https://wa.me/2347040004422" style="color:#007bff;font-weight:600;">
    07040004422
  </a>.
</p>

<br/>

<h4>Verified Sources</h4>
${verifiedSourcesHTML}
  `.trim();

  console.log("Final HTML Content:", htmlContent);

  const response = await prisma.response.upsert({
    where: { threatId },
    update: {
      content: htmlContent, // 🔹 HTML now stored
      sourcesUsed,
      confidence: threat.verificationConfidence ?? 80,
      status: ResponseStatus.PENDING,
      autoGenerated: true,
    },
    create: {
      threatId,
      platform: threat.detectedPost.platform,
      content: htmlContent,
      sourcesUsed,
      confidence: threat.verificationConfidence ?? 80,
      status: ResponseStatus.PENDING,
      autoGenerated: true,
    },
  });

  console.log(`⚠️ AI Response generated for threat ${threatId}`);

  // 🔔 Notify frontend dashboard
  wsBroadcast?.("response_ready", {
    threatId,
    responseId: response.id,
    preview: rawContent.slice(0, 240),
    confidence: response.confidence,
    sourcesUsed,
  });

  return response;
}

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
//       ? evidence
//           .map((s) => `• ${s.title ?? s.url} (${new URL(s.url).hostname})`)
//           .join("\n")
//       : "• No press references available yet.";

//   const completion = await groq.chat.completions.create({
//     model: "llama-3.3-70b-versatile",
//     temperature: 0.3,
//     messages: [
//       {
//         role: "system",
//         content:
//           "You write short, calm, factual brand corrections. No insults. No speculation.",
//       },
//       {
//         role: "user",
//         content: `Brand: ${brandName}
// Claim (false): "${claim}"

// Write a confident public correction (2–3 sentences). Include a 'Sources' block from the provided items, no fabrications.

// Sources:
// ${sourcesBlock}

// Return ONLY the final text.`,
//       },
//     ],
//   });

//   const content =
//     completion.choices[0]?.message?.content?.trim() ||
//     `${brandName}: This claim is incorrect. Operations remain normal.\n\nSources:\n${sourcesBlock}`;

//     console.log('Generated response content:', content);

//   const sourcesUsed = evidence.map((s) => s.url);

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

//   console.log(`⚠️ AI Response generated for threat ${threatId}`);
//   console.log('response content:', response);

//   // 🔔 notify dashboard
//   wsBroadcast?.("response_ready", {
//     threatId,
//     responseId: response.id,
//     preview: content.slice(0, 240),
//     confidence: response.confidence,
//     sourcesUsed,
//   });

//   return response;
// }

/** [6] Post Konfam response to X-clone */
export async function postResponseToXClone(responseId: string) {

  const response = await prisma.response.findUnique({
  where: { id: responseId },
  select: {
    id: true,
    content: true,
    threatId: true, // top-level threat FK
    threat: {
      select: {
        id: true, // threat.id (redundant with threatId but explicit)
        detectedPostId: true,
        detectedPost: {
          select: {
            id: true,
            authorHandle: true,
            authorId: true,
            externalPostId: true,
          },
        },
      },
    },
  },
});

if (!response) throw new Error("Response not found");

const responseContent = response.content;
const threatId = response.threatId ?? response.threat?.id;
const detectedPostId = response.threat?.detectedPost.externalPostId;
const authorHandle = response.threat?.detectedPost?.authorHandle;
const authorId = response.threat?.detectedPost?.authorId;

if (!detectedPostId) throw new Error("Detected post not found for threat");

  if (!response) throw new Error("Response not found");

  console.log('The Response to post:', response);

  const target = response.threat.detectedPost;

  console.log('externalPostId of target:', detectedPostId);

  // -----------------------------------------------------
  // 🟩 Build correct payload for /api/twitter/tweets
  // -----------------------------------------------------
  const payload = {
    text: `@${authorHandle} ${response.content}`,
    //reply_to: target.id,                  // Replies to the detected post
    quote_tweet: detectedPostId,                    // Not using quote tweet here
    language: "ENGLISH",
    is_konfam_response: true,
  };

  console.log("🚀 Posting to X-clone:", payload);

  try {
    const url = `${process.env.XCLONE_API_URL}/api/twitter/tweets`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log('X-clone response status:', res.status);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`X-clone response: ${text}`);
    }
    console.log('X-clone response text:', text);

    // Update DB
    await prisma.response.update({
      where: { id: responseId },
      data: {
        status: ResponseStatus.POSTED,
        postedAt: new Date(),
      },
    });

    console.log(`✅ Response ${responseId} posted successfully.`);

    // Broadcast to dashboard
    wsBroadcast?.("response_posted", {
      responseId,
      threatId: response.threatId,
      postedAt: new Date().toISOString(),
    });

  } catch (err: any) {
    console.error(`❌ Failed to post response ${responseId}: ${err.message}`);

    await prisma.response.update({
      where: { id: responseId },
      data: { status: ResponseStatus.FAILED },
    });

    wsBroadcast?.("response_failed", {
      responseId,
      threatId: response.threatId,
      error: err.message,
    });

    throw err;
  }
}


/** [3–6] Orchestrator used by the worker */
/** [3–6] Orchestrator used by the worker */
export async function handleThreatVerifyRespond(
  threatId: string,
  autopost = false
) {
  const { verificationStatus } = await verifyThreat(threatId);

  console.log("verificationStatus:", verificationStatus);

  // ✅ Correct logic: only FALSE or UNVERIFIED trigger responses
  if (verificationStatus === "FALSE" || verificationStatus === "UNVERIFIED") {
    const resp = await generateResponseForFalse(threatId);
    console.log(`⚠️ Generated response ${resp.id}`);

    if (autopost) {
      await postResponseToXClone(resp.id);
    }

    return { verified: false, action: "responded", responseId: resp.id };
  }

  // TRUE case → no misinformation
  wsBroadcast?.("verification_complete", {
    threatId,
    status: "VERIFIED_TRUE",
    message: "✅ Verified as true — no response needed",
  });

  console.log(
    `✅ Threat ${threatId} verification finished → ${verificationStatus}`
  );

  return {
    verified: true,
    action: "no_response_needed",
    status: verificationStatus,
  };
}

// export async function handleThreatVerifyRespond(threatId: string, autopost = false) {
//   const { verificationStatus } = await verifyThreat(threatId);

//   console.log('verificationStatus:', verificationStatus);

//   if (verificationStatus === "FALSE" || "UNVERIFIED") {
//     const resp = await generateResponseForFalse(threatId);
//     console.log(`⚠️ Generated response ${resp}`);
//     if (autopost) await postResponseToXClone(resp.id);
//     return { verified: false, action: "responded", responseId: resp.id };
//   }

//   if (verificationStatus === "TRUE") {
//     wsBroadcast?.("verification_complete", {
//       threatId,
//       status: "VERIFIED_TRUE",
//       message: "✅ Verified as true — no response needed",
//     });
//   } else {
//     wsBroadcast?.("verification_complete", {
//       threatId,
//       status: "UNVERIFIED",
//       message: "ℹ️ Could not verify with confidence",
//     });
//   }

//   console.log(`✅ Threat ${threatId} verification finished → ${verificationStatus}`);
//   return { verified: verificationStatus === "TRUE", action: "no_response_needed", status: verificationStatus };
// }