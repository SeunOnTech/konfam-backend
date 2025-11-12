/**
 * test-scrape.ts
 * ------------------------------------------------------------
 * Test scraper that only displays articles related to "Zenith Bank".
 * Uses native fetch + Cheerio (no DB writes).
 * ------------------------------------------------------------
 */

import * as cheerio from "cheerio";
import dotenv from "dotenv";

dotenv.config();

type Source = {
  name: string;
  baseUrl: string;
  entryPaths: string[];
  cssSelector: string;
};

const sources: Source[] = [
  {
    name: "Zenith Bank – News & Updates",
    baseUrl: "https://www.zenithbank.com",
    entryPaths: ["/media/news"],
    cssSelector: "article a, .news-listing a",
  },
  {
    name: "BusinessDay – Banking & Finance",
    baseUrl: "https://businessday.ng",
    entryPaths: ["/banking-finance/"],
    cssSelector: "article h2 a, .bd-archive-listing a",
  },
  {
    name: "Vanguard – Zenith Bank Tag",
    baseUrl: "https://www.vanguardngr.com",
    entryPaths: ["/tag/zenith-bank/"],
    cssSelector: "h3 a, .entry-title a, .jeg_post_title a",
  },
  {
    name: "PUNCH – Banking & Finance",
    baseUrl: "https://punchng.com",
    entryPaths: ["/business/banking-finance/"],
    cssSelector: "h3.post-title a, .entry-title a",
  },
];

// ✅ Keywords to detect Zenith Bank relevance
const ZENITH_KEYWORDS = [
  "zenith bank",
  "zenithbank",
  "@zenithbank",
  "#zenithbank",
  "zenith’s",
];

async function fetchHTML(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "KonfamBot/1.0 (+https://konfam.ai)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err: any) {
    console.error(`❌ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

function isZenithRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return ZENITH_KEYWORDS.some((k) => lower.includes(k));
}

async function scrapeSource(source: Source) {
  console.log(`\n📰 SOURCE: ${source.name}`);

  for (const path of source.entryPaths) {
    const fullUrl = new URL(path, source.baseUrl).href;
    console.log(`🌐 Fetching index: ${fullUrl}`);

    const html = await fetchHTML(fullUrl);
    if (!html) continue;

    const $ = cheerio.load(html);
    const links = new Set<string>();

    $(source.cssSelector).each((_, el) => {
      const href = $(el).attr("href");
      if (href && !href.startsWith("#")) {
        const abs = new URL(href, source.baseUrl).href;
        links.add(abs);
      }
    });

    console.log(`✅ Found ${links.size} article links`);

    const topLinks = Array.from(links).slice(0, 6); // check top 6 articles

    for (const articleUrl of topLinks) {
      const articleHTML = await fetchHTML(articleUrl);
      if (!articleHTML) continue;

      const $$ = cheerio.load(articleHTML);

      const title =
        $$("meta[property='og:title']").attr("content") ||
        $$("title").text().trim() ||
        $$("h1").first().text().trim() ||
        "(No title)";

      const date =
        $$("meta[property='article:published_time']").attr("content") ||
        $$("time").first().attr("datetime") ||
        $$("time").first().text().trim() ||
        "(No date)";

      const paragraphs = $$("p")
        .map((_, el) => $$(el).text().trim())
        .get()
        .filter((t) => t.length > 40)
        .slice(0, 4);

      const bodyText = [title, ...paragraphs].join(" ");

      // ✅ Skip non-Zenith related content
      if (!isZenithRelated(bodyText)) {
        console.log(`⚪ Skipping unrelated article: ${title}`);
        continue;
      }

      console.log(`\n🧾 Article: ${articleUrl}`);
      console.log(`📰 TITLE: ${title}`);
      console.log(`📅 DATE: ${date}`);
      console.log(
        `🧠 PREVIEW:\n${paragraphs.length ? paragraphs.join("\n\n") : "(No readable content)"}`
      );
    }
  }
}

async function main() {
  console.log("🚀 Starting Zenith-only scraper test...\n");
  for (const src of sources) {
    await scrapeSource(src);
  }
  console.log("\n✅ Scrape test complete (Zenith Bank only).");
}

main();
