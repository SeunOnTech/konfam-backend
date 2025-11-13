/**
 * generate-crisis-scenario.ts
 * ------------------------------------------------------------
 * Reads current brand sentiment & scraped data,
 * then generates 3 realistic, high-fidelity
 * misinformation crisis simulation scenarios.
 *
 * - No DB writes
 * - Designed for Konfam crisis simulation pipeline
 * ------------------------------------------------------------
 */

import { PrismaClient } from "@prisma/client";
import Groq from "groq-sdk";
import * as dotenv from "dotenv";
dotenv.config();

const prisma = new PrismaClient();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

async function generateCrisisScenario() {
  console.log("\n🧠 Generating multi-angle crisis misinformation scenarios...\n");

  // 1️⃣ Fetch recent high-credibility positive articles about Zenith Bank
  const positives = await prisma.scrapedItem.findMany({
    where: { credibility: { gte: 0.6 } },
    orderBy: { publishedAt: "desc" },
    take: 5,
  });

  if (positives.length === 0) {
    console.log("⚠️ No scraped items found. Run BrandIntelligenceService first.");
    return;
  }

  console.log(`📰 Loaded ${positives.length} recent positive articles.\n`);

  // 2️⃣ Normalize / prepare structured article blocks for the LLM
  const articleBlocks = positives
    .map((p, i) => {
      const meta = (p.scrapedMeta as any) || {};
      const sentimentIndicators = meta.sentimentIndicators || {};
      const negative = Array.isArray(sentimentIndicators.negative)
        ? sentimentIndicators.negative
        : [];
      const positive = Array.isArray(sentimentIndicators.positive)
        ? sentimentIndicators.positive
        : [];

      const snippet =
        (p.content || "").split(/\s+/).slice(0, 120).join(" ") + "...";

      return `
### Article ${i + 1}
Title: ${p.title}
URL: ${p.url}
Category: ${meta.category || "Unknown"}
Source: ${meta.source || "Unknown"}
Tags: ${Array.isArray(p.tags) ? p.tags.join(", ") : ""}
Credibility Score: ${p.credibility}
Word Count: ${meta.wordCount || "Unknown"}
Sentiment Indicators: negative=${negative.length}, positive=${positive.length}
Snippet: ${snippet}
`;
    })
    .join("\n");

  // 3️⃣ Build a high-intelligence, hybrid-style prompt
  const prompt = `
You are an elite crisis simulation strategist for a Nigerian bank-monitoring system called Konfam.
You have:
- Real scraped articles about Zenith Bank Nigeria.
- Knowledge of how misinformation spreads on X (Twitter), TikTok, and WhatsApp in Nigeria.
- A war-room mindset for PR, compliance, and risk.

Below is REAL recent positive coverage about Zenith Bank Nigeria:

${articleBlocks}

---

🎯 OVERALL TASK:
Use the data above to generate **3 completely different, high-fidelity misinformation crisis scenarios** that Konfam should simulate.

Each scenario should be written in a **hybrid tone**:
- Strategic and structured enough for a corporate crisis HQ.
- Realistic and grounded in how Nigerians actually talk and react online.
- War-room minded: focused on risk, escalation, and response.

For EACH of the 3 scenarios, output with this structure:

Scenario X:
Summary:
- 2–3 sentences summarising the crisis scenario in plain language.

False claim (description only):
- Describe the nature of the misinformation (e.g. "a viral claim that...").
- DO NOT write the fake tweet or any explicit copy-pastable post.
- DO NOT give step-by-step instructions on how to spread it.

Why people might believe it:
- Reference specific articles, tags, categories, or snippets from the data above.
- Explain the psychology: fear, distrust of banks, previous scandals in the ecosystem, economic context, etc.
- Use Nigerian realities (e.g. FX issues, app downtime history in the sector, distrust of “big banks”).

Trust and risk dimensions:
- Explain which parts of public trust this hits (e.g. funds safety, ethics, cyber, app reliability, regulatory trouble, investor confidence).
- Use natural language (avoid robotic “this attacks the dimension of trust related to…” phrasing).

Likely spreaders & channels:
- Describe what kinds of accounts are likely to amplify it (e.g. “fintech influencers”, “angry customers”, “pseudo-activist pages”, “clickbait blogs”).
- Mention key channels: X, TikTok, WhatsApp groups, Facebook, blogs.
- Briefly mention how fast it might trend and why.

Severity (Low / Medium / High + short reason):
- Give a severity label and one short explanation grounded in impact and plausibility.

Verification strategy (for Konfam / the bank):
- Explain what Konfam and the bank’s verification team should actually do:
  - What to cross-check (official statements, transaction logs, system uptime, central bank filings, etc.).
  - Who to call internally (IT, cyber, treasury, HR, compliance, etc.).
  - Which external sources (regulators, reputable media, industry reports).

Response & narrative strategy:
- Explain the recommended response style:
  - Calm clarification? Strong denial? Data-heavy thread? Short video? Press release?
- Mention what angle to lean on:
  - transparency, empathy, technical detail, showcasing controls, human stories, 3rd-party validation.
- Explain how to adapt the tone per channel (X vs TikTok vs press).

Crisis evolution (Phase 1 → Phase 3):
- Phase 1 (0–2 hours): what it looks like and who is talking.
- Phase 2 (2–24 hours): does it jump into media, influencers, regulators, or board-level concern?
- Phase 3 (24–72 hours): what happens if unmanaged, and what “success” looks like if the response works.

IMPORTANT:
- All 3 scenarios must be **meaningfully different** (e.g. one could target cyber/data breach, another ethics/governance, another funds safety or regulatory sanctions).
- Ground your reasoning in the specific articles above (e.g. Tech Fair 2025, Zecathon 5.0, Bank of the Year award, strong market rally, high interest earnings, etc.).
- Do NOT output any explicit misinformation message that could be copy-pasted as-is into social media.
- Stay at the level of description, analysis, and strategy.

Return your answer in this exact format:

Scenario 1:
[content]

Scenario 2:
[content]

Scenario 3:
[content]
`;

  // 4️⃣ Call Groq to generate the rich, multi-angle scenarios
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0.55, // balanced: not too wild, not too stiff
    max_tokens: 1800,
    messages: [
      {
        role: "system",
        content:
          "You are an expert crisis intelligence and misinformation simulation strategist. Be precise, grounded, and realistic.",
      },
      { role: "user", content: prompt },
    ],
  });

  const output = res.choices[0]?.message?.content?.trim() || "No scenario generated.";

  console.log("------------------------------------------------------------");
  console.log("🧾 Generated Crisis Simulation Scenarios:\n");
  console.log(output);
  console.log("------------------------------------------------------------\n");

  await prisma.$disconnect();
}

generateCrisisScenario()
  .then(() => console.log("✅ Scenario generation complete.\n"))
  .catch((err) => {
    console.error("❌ Error:", err);
    prisma.$disconnect();
  });


// /**
//  * generate-crisis-scenario.ts
//  * ------------------------------------------------------------
//  * Reads current brand sentiment & scraped data,
//  * then generates 3 realistic *crisis scenario descriptions*
//  * for misinformation simulations.
//  *
//  * NOTE: Does NOT create or insert any data into DB.
//  * ------------------------------------------------------------
//  */

// import { PrismaClient } from "@prisma/client";
// import Groq from "groq-sdk";
// import * as dotenv from "dotenv";
// dotenv.config();

// const prisma = new PrismaClient();
// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// async function generateCrisisScenario() {
//   console.log("\n🧠 Generating advanced crisis misinformation scenarios...\n");

//   // 1️⃣ Fetch recent high-credibility positive articles
//   const positives = await prisma.scrapedItem.findMany({
//     where: { credibility: { gte: 0.6 } },
//     orderBy: { publishedAt: "desc" },
//     take: 5,
//   });

//   if (positives.length === 0) {
//     console.log("⚠️ No scraped items found. Run BrandIntelligenceService first.");
//     return;
//   }

//   console.log(`📰 Loaded ${positives.length} recent positive articles.\n`);

//   // 2️⃣ Build structured article input for the LLM
//   const articleBlocks = positives
//     .map(
//       (p, i) => `
// ### Article ${i + 1}
// Title: ${p.title}
// URL: ${p.url}
// Category: ${p.scrapedMeta?.category || "Unknown"}
// Tags: ${p.tags.join(", ")}
// Credibility Score: ${p.credibility}
// Word Count: ${p.scrapedMeta?.wordCount}
// Sentiment Indicators: negative=${p.scrapedMeta?.sentimentIndicators?.negative?.length || 0}, positive=${p.scrapedMeta?.sentimentIndicators?.positive?.length || 0}
// `
//     )
//     .join("\n");

//   // 3️⃣ Build advanced multi-scenario prompt
//   const prompt = `
// You are an elite crisis-simulation strategist for financial institutions in West Africa.
// You analyze real brand perception data, detect vulnerabilities, and design high-fidelity misinformation scenarios.

// Below is REAL recent positive media coverage about Zenith Bank Nigeria:

// ${articleBlocks}

// ---

// ### 🎯 TASK:
// Using the above data, generate **3 completely different, high-quality misinformation crisis scenarios**.

// Each scenario MUST:

// 1. Be a **4–6 sentence paragraph**.
// 2. Describe the *false claim*, without writing the fake tweet itself.
// 3. Explain **why the public might believe it**, using correlations to the actual articles.
// 4. Identify **which dimension of trust** it attacks, e.g.:
//    - funds safety & liquidity
//    - app / digital reliability
//    - cybersecurity / data breach
//    - ethics & governance
//    - innovation credibility
//    - regulatory compliance
//    - market performance
// 5. Reference which of the scraped articles make this misinformation *feel plausible*.
// 6. Explain what *real facts* could be used to debunk it.

// ### IMPORTANT:
// - Make all 3 scenarios **unique**, not variations of one idea.
// - The scenarios should feel **Nigerian**, **realistic**, **platform-appropriate**, and consistent with how misinformation spreads on X and TikTok.
// - You MUST deeply correlate your reasoning across multiple articles, not just one.

// Return the 3 scenarios as:

// Scenario 1:
// (text)

// Scenario 2:
// (text)

// Scenario 3:
// (text)
// `;

//   // 4️⃣ Ask Llama-3.3 for deep, multi-scenario output
//   const res = await groq.chat.completions.create({
//     model: "llama-3.3-70b-versatile",
//     temperature: 0.55, // balanced intelligence + creativity
//     max_tokens: 1200,
//     messages: [
//       { role: "system", content: "Provide expert-level crisis simulation output only." },
//       { role: "user", content: prompt }
//     ],
//   });

//   const output = res.choices[0]?.message?.content?.trim() || "No scenario generated.";

//   console.log("------------------------------------------------------------");
//   console.log("🧾 Generated Crisis Simulation Scenarios:\n");
//   console.log(output);
//   console.log("------------------------------------------------------------\n");

//   await prisma.$disconnect();
// }

// generateCrisisScenario()
//   .then(() => console.log("✅ Scenario generation complete.\n"))
//   .catch((err) => {
//     console.error("❌ Error:", err);
//     prisma.$disconnect();
//   });

// /**
//  * generate-crisis-scenario.ts
//  * ------------------------------------------------------------
//  * Reads current brand sentiment & scraped data,
//  * then generates a realistic *scenario description*
//  * for what kind of crisis or misinformation post
//  * should be simulated to test the Konfam pipeline.
//  *
//  * NOTE: Does NOT create or insert any data.
//  * ------------------------------------------------------------
//  */

// import { PrismaClient } from "@prisma/client";
// import Groq from "groq-sdk";
// import * as dotenv from "dotenv";
// dotenv.config();

// const prisma = new PrismaClient();
// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// async function generateCrisisScenario() {
//   console.log("\n🧠 Generating realistic misinformation scenario...\n");

//   // 1️⃣ Fetch recent positive news about the brand
//   const positives = await prisma.scrapedItem.findMany({
//     where: { credibility: { gte: 0.6 } },
//     orderBy: { publishedAt: "desc" },
//     take: 5,
//   });

//   console.log('positives:', positives);

//   if (positives.length === 0) {
//     console.log("⚠️ No scraped items found. Run the BrandIntelligenceService first.");
//     return;
//   }

//   const headlines = positives.map((p) => `- ${p.title ?? p.url}`).join("\n");
//   console.log(`📰 Loaded ${positives.length} recent positive articles.`);

//   // 2️⃣ Feed into LLM to create a realistic *scenario outline*
//   const prompt = `
// You are a crisis simulation expert. The brand "Zenith Bank Nigeria" currently has strong positive media coverage:

// ${headlines}

// Using this background, describe — in one short paragraph — 
// what kind of *misinformation post* would be most realistic to test our detection and verification system.

// The paragraph should:
// - Not include the actual tweet text.
// - Explain the *nature* of the false claim (e.g. "a viral claim about...").
// - Indicate what aspect of public trust it targets (e.g. app reliability, funds safety, ethics, etc.).
// - Suggest what true data from existing coverage could be used to debunk it.
// `;

//   const res = await groq.chat.completions.create({
//     model: "llama-3.3-70b-versatile",
//     temperature: 0.6,
//     messages: [{ role: "user", content: prompt }],
//   });

//   const scenario = res.choices[0]?.message?.content?.trim();

//   console.log("------------------------------------------------------------");
//   console.log("🧾 Recommended Crisis Simulation Scenario:\n");
//   console.log(scenario);
//   console.log("------------------------------------------------------------\n");

//   await prisma.$disconnect();
// }

// generateCrisisScenario()
//   .then(() => console.log("✅ Scenario generation complete.\n"))
//   .catch((err) => console.error("❌ Error:", err));
