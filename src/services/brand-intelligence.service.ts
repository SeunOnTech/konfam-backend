/**
 * BrandIntelligenceService
 * ------------------------------------------------------------
 * - Fetches & analyzes brand-related articles
 * - Scrapes mandatory brand URLs (always)
 * - Filters out negative or neutral sentiment
 * - Stores only positive, credible content
 * - Avoids redundant re-scraping
 * ------------------------------------------------------------
 */

import fetch, { RequestInit } from "node-fetch";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";
import Groq from "groq-sdk";
import Sentiment from "sentiment";

dotenv.config();

const prisma = new PrismaClient();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
const sentiment = new Sentiment();

export class BrandIntelligenceService {
  private CONFIG = {
    SERPAPI_KEY: process.env.SERPAPI_API_KEY || "",
    // BRAND_ID: "cmhv9nskc0002uu3cl92dyovn",
    BRAND_ID: "cmhxydh4d0002uucw5tkhni6o",
    BRAND_NAME: "Zenith Bank Nigeria",
    MAX_RESULTS_PER_SOURCE: 8,
    FETCH_FULL_CONTENT: true,
    SCRAPE_INTERVAL_MINUTES: 60,

    // 🔥 Mandatory URLs to scrape EVERY run
    MANDATORY_URLS: [
      {
        url: "https://www.zenithbank.com/",
        label: "Official Homepage",
        source: "Zenith Bank",
      },
      {
        url: "https://www.zenithbank.com/media/news/",
        label: "Official News",
        source: "Zenith Bank",
      },
      {
        url: "https://www.zenithbank.com/customer-service/?id=SCAM_ALERT",
        label: "Customer Service - Scam Alert",
        source: "Zenith Bank",
      }
    ],

    QUERIES: [
      { type: "news", query: "Zenith Bank Nigeria", label: "General News" },
      { type: "news", query: "Zenith Bank Nigeria CSR OR sustainability OR donation OR impact", label: "CSR & Impact" },
      { type: "search", query: "Zenith Bank Nigeria awards OR recognition OR ranking OR best bank", label: "Awards & Recognition" },
      { type: "search", query: "Zenith Bank Nigeria partnership OR fintech OR innovation OR launch", label: "Innovation & Partnerships" },
      { type: "search", query: "Zenith Bank Nigeria financial performance OR growth OR expansion", label: "Growth & Performance" },
    ],
  };

  private negativeKeywords = [
    "scam","fraud","complaint","lawsuit","illegal","breach","hack","stolen",
    "loss","fail","poor","bad","terrible","worst","avoid","warning","alert",
    "crisis","scandal","corruption","embezzlement","theft","negligence","abuse",
  ];

  private positiveKeywords = [
    "award","best","excellent","success","growth","innovation","leader","top",
    "great","outstanding","achievement","win","partnership","expansion",
    "milestone","recognized","celebrates","commend","progress",
  ];

  private calculateCredibility(article: any): number {
    let score = 0.5;
    const trusted = [
      "bbc.com","reuters.com","bloomberg.com","ft.com","theguardian.com","cnn.com",
      "premiumtimesng.com","punchng.com","thecable.ng",
    ];
    const domain = new URL(article.url).hostname.replace("www.", "");
    if (trusted.some((d) => domain.includes(d))) score += 0.3;
    if (article.authors.length > 0) score += 0.1;
    if (article.publishedAt) score += 0.1;
    return Math.min(1, Math.max(0, score));
  }

  private generateContentHash(content: string) {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private extractAuthors($: cheerio.CheerioAPI): string[] {
    const authors: string[] = [];
    const selectors = [
      'meta[name="author"]',
      'meta[property="article:author"]',
      ".author-name",
      ".author",
      "[rel='author']",
      ".byline",
    ];

    for (const selector of selectors) {
      $(selector).each((_, el) => {
        const content = $(el).attr("content") || $(el).text().trim();
        if (content && content.length > 2 && content.length < 100) {
          authors.push(content);
        }
      });
    }

    return [...new Set(authors)];
  }

  private extractPublishedDate($: cheerio.CheerioAPI): Date | null {
    const selectors = [
      'meta[property="article:published_time"]',
      'meta[name="publication_date"]',
      'meta[name="date"]',
      "time[datetime]",
      ".published-date",
      ".post-date",
    ];

    for (const selector of selectors) {
      const el = $(selector).first();
      const dateStr =
        el.attr("content") ||
        el.attr("datetime") ||
        el.text().trim();

      if (dateStr) {
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) return date;
      }
    }

    return null;
  }

  private extractCanonicalUrl($: cheerio.CheerioAPI, url: string): string {
    return $('link[rel="canonical"]').attr("href") || url;
  }

  private analyzeSentiment(text: string) {
    const t = text.toLowerCase();
    return {
      negative: this.negativeKeywords.filter((k) => t.includes(k)),
      positive: this.positiveKeywords.filter((k) => t.includes(k)),
    };
  }

  private async fetchArticleContent(url: string, category: string, source: string) {
    try {
      const options: RequestInit = {
        headers: { "User-Agent": "Mozilla/5.0 (KonfamBot/1.0)" }
      };

      const response = await fetch(url, options);
      if (!response.ok) return null;

      const html = await response.text();
      const $ = cheerio.load(html);

      const title =
        $('meta[property="og:title"]').attr("content") ||
        $("title").text() ||
        $("h1").first().text();

      const description =
        $('meta[property="og:description"]').attr("content") ||
        $('meta[name="description"]').attr("content") ||
        "";

      const authors = this.extractAuthors($);
      const publishedAt = this.extractPublishedDate($);
      const canonicalUrl = this.extractCanonicalUrl($, url);

      $("script, style, nav, header, footer, aside, .ad, .popup").remove();

      const paragraphs: string[] = [];
      $("article p, main p, .content p").each((_, el) => {
        const text = $(el).text().trim();
        if (text && text.length > 80) paragraphs.push(text);
      });

      const content = paragraphs.join("\n\n");
      if (content.split(/\s+/).length < 50) return null;

      const sentimentIndicators = this.analyzeSentiment(content);

      return {
        url: canonicalUrl,
        title: title?.trim() || "Untitled",
        content,
        excerpt: description.substring(0, 500),
        authors,
        publishedAt,
        tags: [
          ...sentimentIndicators.negative,
          ...sentimentIndicators.positive,
          category.toLowerCase(),
        ],
        scrapedMeta: {
          source,
          description,
          category,
          sentimentIndicators,
          wordCount: content.split(/\s+/).length,
        },
      };
    } catch {
      return null;
    }
  }

  private async searchSource(query: string, type: string, label: string) {
    try {
      const params = new URLSearchParams({
        engine: "google",
        q: query,
        api_key: this.CONFIG.SERPAPI_KEY,
        num: this.CONFIG.MAX_RESULTS_PER_SOURCE.toString(),
        ...(type === "news" && { tbm: "nws" })
      });

      const res = await fetch(`https://serpapi.com/search?${params.toString()}`);
      const raw = await res.json();

      const data = raw as any;

      const results = data.news_results || data.organic_results || [];

      return results.map((r: any) => ({
        url: r.link,
        source: r.source || r.displayed_link || new URL(r.link).hostname,
        category: label,
      }));
    } catch {
      return [];
    }
  }

  async runScrapeCycle() {
    const now = new Date();
    const seenHashes = new Set<string>();

    const scrapeSource = await prisma.scrapeSource.upsert({
      where: { name: `${this.CONFIG.BRAND_NAME} - Web Intelligence` },
      update: { lastCrawledAt: now, updatedAt: now, isActive: true },
      create: {
        brandId: this.CONFIG.BRAND_ID,
        name: `${this.CONFIG.BRAND_NAME} - Web Intelligence`,
        baseUrl: "https://www.google.com",
        entryPaths: this.CONFIG.QUERIES.map((q) => q.query),
        type: "news",
        crawlInterval: this.CONFIG.SCRAPE_INTERVAL_MINUTES * 60,
        lastCrawledAt: now,
      },
    });

    console.log("📌 Scraping mandatory Zenith Bank sources...\n");

    // =========================================================
    // 🔥 MANDATORY SOURCES SCRAPE
    // =========================================================
    for (const entry of this.CONFIG.MANDATORY_URLS) {
      const recent = await prisma.scrapedItem.findFirst({
        where: {
          url: entry.url,
          updatedAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      });

      if (recent) {
        console.log(`⏩ Skipped mandatory (recent): ${entry.url}`);
        continue;
      }

      const article = await this.fetchArticleContent(
        entry.url,
        entry.label,
        entry.source
      );

      if (!article) {
        console.log(`⚠️ Failed to scrape mandatory: ${entry.url}`);
        continue;
      }

      const hash = this.generateContentHash(article.content);

      await prisma.scrapedItem.upsert({
        where: { url: article.url },
        update: {
          title: article.title,
          authors: article.authors,
          excerpt: article.excerpt,
          content: article.content,
          contentHash: hash,
          tags: article.tags,
          scrapedMeta: article.scrapedMeta,
          updatedAt: now,
        },
        create: {
          sourceId: scrapeSource.id,
          url: article.url,
          canonicalUrl: article.url,
          title: article.title,
          authors: article.authors,
          publishedAt: article.publishedAt,
          excerpt: article.excerpt,
          content: article.content,
          contentHash: hash,
          tags: article.tags,
          credibility: this.calculateCredibility(article),
          scrapedMeta: article.scrapedMeta,
          language: "en",
        },
      });

      console.log(`✅ Saved mandatory source: ${article.title}`);
    }

    // =========================================================
    // 🔥 SERP SEARCH SCRAPE
    // =========================================================

    console.log(`📡 Running wide scrape for ${this.CONFIG.BRAND_NAME}...\n`);

    for (const queryConfig of this.CONFIG.QUERIES) {
      const searchResults = await this.searchSource(
        queryConfig.query,
        queryConfig.type,
        queryConfig.label
      );

      for (const result of searchResults) {
        const recent = await prisma.scrapedItem.findFirst({
          where: {
            url: result.url,
            updatedAt: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        });

        if (recent) {
          console.log(`⏩ Skipped (recent): ${result.url}`);
          continue;
        }

        const article = await this.fetchArticleContent(
          result.url,
          result.category,
          result.source
        );

        if (!article) continue;

        const hash = this.generateContentHash(article.content);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        let sentimentScore = 0;
        try {
          const prompt = `
Rate the sentiment about ${this.CONFIG.BRAND_NAME} from -1 to +1.
Return only JSON: {"sentimentScore": 0.5}
Text: """${article.content.slice(0, 1000)}"""`;

          const ai = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            temperature: 0.2,
            messages: [
              { role: "system", content: "Be objective." },
              { role: "user", content: prompt },
            ],
          });

          const raw = ai.choices[0]?.message?.content ?? "{}";
          const parsed = JSON.parse(raw);
          sentimentScore = parsed.sentimentScore ?? 0;
        } catch {
          const fallback = sentiment.analyze(article.content);
          sentimentScore = fallback.comparative;
        }

        if (sentimentScore < 0.2) {
          console.log(`🚫 Skipped (neutral/negative): ${article.title}`);
          continue;
        }

        const credibility = this.calculateCredibility(article);

        await prisma.scrapedItem.upsert({
          where: { url: article.url },
          update: {
            title: article.title,
            authors: article.authors,
            excerpt: article.excerpt,
            content: article.content,
            contentHash: hash,
            tags: article.tags,
            credibility,
            scrapedMeta: article.scrapedMeta,
            updatedAt: now,
          },
          create: {
            sourceId: scrapeSource.id,
            url: article.url,
            canonicalUrl: article.url,
            title: article.title,
            authors: article.authors,
            publishedAt: article.publishedAt,
            excerpt: article.excerpt,
            content: article.content,
            contentHash: hash,
            tags: article.tags,
            credibility,
            scrapedMeta: article.scrapedMeta,
            language: "en",
          },
        });

        console.log(`✅ Saved positive article: ${article.title}`);
      }
    }

    console.log(`\n✅ Wide scrape complete at ${now.toISOString()}\n`);
  }
}

// /**
//  * BrandIntelligenceService
//  * ------------------------------------------------------------
//  * - Fetches & analyzes brand-related articles
//  * - Filters out negative or neutral sentiment
//  * - Stores only positive, credible data in DB
//  * - Avoids redundant re-scraping each run
//  * ------------------------------------------------------------
//  */

// import fetch from "node-fetch";
// import * as cheerio from "cheerio";
// import crypto from "crypto";
// import { PrismaClient } from "@prisma/client";
// import * as dotenv from "dotenv";
// import Groq from "groq-sdk";
// import Sentiment from "sentiment";

// dotenv.config();

// const prisma = new PrismaClient();
// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
// const sentiment = new Sentiment();

// export class BrandIntelligenceService {
//   private CONFIG = {
//     SERPAPI_KEY: process.env.SERPAPI_API_KEY || "",
//     BRAND_ID: "cmhv9nskc0002uu3cl92dyovn",
//     BRAND_NAME: "Zenith Bank Nigeria",
//     MAX_RESULTS_PER_SOURCE: 8, // widened search
//     FETCH_FULL_CONTENT: true,
//     SCRAPE_INTERVAL_MINUTES: 60,
//     QUERIES: [
//       { type: "news", query: "Zenith Bank Nigeria", label: "General News" },
//       { type: "news", query: "Zenith Bank Nigeria CSR OR sustainability OR donation OR impact", label: "CSR & Impact" },
//       { type: "search", query: "Zenith Bank Nigeria awards OR recognition OR ranking OR best bank", label: "Awards & Recognition" },
//       { type: "search", query: "Zenith Bank Nigeria partnership OR fintech OR innovation OR launch", label: "Innovation & Partnerships" },
//       { type: "search", query: "Zenith Bank Nigeria financial performance OR growth OR expansion", label: "Growth & Performance" },
//     ],
//   };

//   private negativeKeywords = [
//     "scam","fraud","complaint","lawsuit","illegal","breach","hack","stolen",
//     "loss","fail","poor","bad","terrible","worst","avoid","warning","alert",
//     "crisis","scandal","corruption","embezzlement","theft","negligence","abuse",
//   ];

//   private positiveKeywords = [
//     "award","best","excellent","success","growth","innovation","leader","top",
//     "great","outstanding","achievement","win","partnership","expansion",
//     "milestone","recognized","celebrates","commend","progress",
//   ];

//   private calculateCredibility(article: any): number {
//     let score = 0.5;
//     const trusted = [
//       "bbc.com","reuters.com","bloomberg.com","ft.com","theguardian.com","cnn.com",
//       "premiumtimesng.com","punchng.com","thecable.ng",
//     ];
//     const domain = new URL(article.url).hostname.replace("www.", "");
//     if (trusted.some((d) => domain.includes(d))) score += 0.3;
//     if (article.authors.length > 0) score += 0.1;
//     if (article.publishedAt) score += 0.1;
//     return Math.max(0, Math.min(1, score));
//   }

//   private generateContentHash(content: string) {
//     return crypto.createHash("sha256").update(content).digest("hex");
//   }

//   private extractAuthors($: cheerio.CheerioAPI): string[] {
//     const authors: string[] = [];
//     const selectors = [
//       'meta[name="author"]',
//       'meta[property="article:author"]',
//       ".author-name",
//       ".author",
//       "[rel='author']",
//       ".byline",
//     ];
//     for (const selector of selectors) {
//       $(selector).each((_, el) => {
//         const content = $(el).attr("content") || $(el).text().trim();
//         if (content && content.length > 2 && content.length < 100)
//           authors.push(content);
//       });
//     }
//     return [...new Set(authors)];
//   }

//   private extractPublishedDate($: cheerio.CheerioAPI): Date | null {
//     const selectors = [
//       'meta[property="article:published_time"]',
//       'meta[name="publication_date"]',
//       'meta[name="date"]',
//       "time[datetime]",
//       ".published-date",
//       ".post-date",
//     ];
//     for (const selector of selectors) {
//       const el = $(selector).first();
//       const dateStr =
//         el.attr("content") || el.attr("datetime") || el.text().trim();
//       if (dateStr) {
//         const date = new Date(dateStr);
//         if (!isNaN(date.getTime())) return date;
//       }
//     }
//     return null;
//   }

//   private extractCanonicalUrl($: cheerio.CheerioAPI, url: string): string {
//     const canonical = $('link[rel="canonical"]').attr("href");
//     return canonical || url;
//   }

//   private analyzeSentiment(text: string) {
//     const lowerText = text.toLowerCase();
//     const negative = this.negativeKeywords.filter((kw) => lowerText.includes(kw));
//     const positive = this.positiveKeywords.filter((kw) => lowerText.includes(kw));
//     return { negative, positive };
//   }

//   private async fetchArticleContent(url: string, category: string, source: string) {
//     try {
//       const response = await fetch(url, {
//         headers: { "User-Agent": "Mozilla/5.0 (KonfamBot/1.0)" },
//         timeout: 10000,
//       });
//       if (!response.ok) return null;

//       const html = await response.text();
//       const $ = cheerio.load(html);

//       const title =
//         $('meta[property="og:title"]').attr("content") ||
//         $("title").text() ||
//         $("h1").first().text() ||
//         "Untitled";

//       const description =
//         $('meta[property="og:description"]').attr("content") ||
//         $('meta[name="description"]').attr("content") ||
//         "";

//       const authors = this.extractAuthors($);
//       const publishedAt = this.extractPublishedDate($);
//       const canonicalUrl = this.extractCanonicalUrl($, url);

//       $("script, style, nav, header, footer, aside, .ad, .popup").remove();

//       const paragraphs: string[] = [];
//       $("article p, main p, .content p").each((_, el) => {
//         const text = $(el).text().trim();
//         if (text && text.length > 100) paragraphs.push(text);
//       });

//       const content = paragraphs.join("\n\n");
//       if (content.split(/\s+/).length < 50) return null;

//       const sentimentIndicators = this.analyzeSentiment(content);
//       const tags = [
//         ...sentimentIndicators.negative,
//         ...sentimentIndicators.positive,
//         category.toLowerCase().replace(/\s+/g, "-"),
//       ];

//       return {
//         url: canonicalUrl,
//         title: title.trim(),
//         content,
//         excerpt: description.substring(0, 500),
//         authors,
//         publishedAt,
//         tags,
//         scrapedMeta: {
//           source,
//           description,
//           category,
//           sentimentIndicators,
//           wordCount: content.split(/\s+/).length,
//         },
//       };
//     } catch {
//       return null;
//     }
//   }

//   private async searchSource(query: string, type: string, label: string) {
//     const params = new URLSearchParams({
//       engine: "google",
//       q: query,
//       api_key: this.CONFIG.SERPAPI_KEY,
//       num: this.CONFIG.MAX_RESULTS_PER_SOURCE.toString(),
//       ...(type === "news" && { tbm: "nws" }),
//     });

//     const res = await fetch(`https://serpapi.com/search?${params.toString()}`);
//     const data = await res.json();
//     const results = data.news_results || data.organic_results || [];

//     return results.map((r: any) => ({
//       url: r.link,
//       source: r.source || r.displayed_link || new URL(r.link).hostname,
//       category: label,
//     }));
//   }

//   async runScrapeCycle() {
//     const now = new Date();
//     const seenHashes = new Set<string>();

//     const scrapeSource = await prisma.scrapeSource.upsert({
//       where: { name: `${this.CONFIG.BRAND_NAME} - Web Intelligence` },
//       update: { lastCrawledAt: now, updatedAt: now, isActive: true },
//       create: {
//         brandId: this.CONFIG.BRAND_ID,
//         name: `${this.CONFIG.BRAND_NAME} - Web Intelligence`,
//         baseUrl: "https://www.google.com",
//         entryPaths: this.CONFIG.QUERIES.map((q) => q.query),
//         type: "news",
//         crawlInterval: this.CONFIG.SCRAPE_INTERVAL_MINUTES * 60,
//         lastCrawledAt: now,
//       },
//     });

//     console.log(`📡 Running wide scrape for ${this.CONFIG.BRAND_NAME}...\n`);

//     for (const queryConfig of this.CONFIG.QUERIES) {
//       const searchResults = await this.searchSource(
//         queryConfig.query,
//         queryConfig.type,
//         queryConfig.label
//       );

//       for (const result of searchResults) {
//         // 🚫 Skip if already scraped recently (within 7 days)
//         const existingRecent = await prisma.scrapedItem.findFirst({
//           where: {
//             url: result.url,
//             updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
//           },
//         });
//         if (existingRecent) {
//           console.log(`⏩ Skipped (recently scraped): ${result.url}`);
//           continue;
//         }

//         const article = await this.fetchArticleContent(
//           result.url,
//           result.category,
//           result.source
//         );
//         if (!article) continue;

//         const contentHash = this.generateContentHash(article.content);
//         if (seenHashes.has(contentHash)) {
//           console.log(`⏩ Duplicate content skipped: ${article.title}`);
//           continue;
//         }
//         seenHashes.add(contentHash);

//         // 🧠 Sentiment Analysis (AI + fallback)
//         let sentimentScore = 0;
//         try {
//           const prompt = `
// Rate the overall sentiment of this article about ${this.CONFIG.BRAND_NAME} from -1 (very negative) to +1 (very positive).
// Return only JSON like: {"sentimentScore": 0.8}
// Text: """${article.content.slice(0, 1000)}"""`;

//           const aiRes = await groq.chat.completions.create({
//             model: "llama-3.3-70b-versatile",
//             temperature: 0.2,
//             messages: [
//               { role: "system", content: "Be objective and consistent with sentiment output." },
//               { role: "user", content: prompt },
//             ],
//           });
//           const raw = aiRes.choices[0]?.message?.content ?? "{}";
//           const parsed = JSON.parse(raw);
//           sentimentScore = parsed.sentimentScore ?? 0;
//         } catch {
//           const result = sentiment.analyze(article.content);
//           sentimentScore = result.comparative;
//         }

//         // 🚫 Skip non-positive content
//         if (sentimentScore < 0.2) {
//           console.log(`🚫 Skipped (not positive enough): ${article.title}`);
//           continue;
//         }

//         const credibility = this.calculateCredibility(article);

//         const existing = await prisma.scrapedItem.findUnique({
//           where: { url: article.url },
//         });

//         if (existing) {
//           if (existing.contentHash !== contentHash) {
//             await prisma.scrapedItem.update({
//               where: { id: existing.id },
//               data: {
//                 title: article.title,
//                 authors: article.authors,
//                 excerpt: article.excerpt,
//                 content: article.content,
//                 contentHash,
//                 tags: article.tags,
//                 credibility,
//                 scrapedMeta: article.scrapedMeta,
//                 updatedAt: now,
//               },
//             });
//             console.log(`🔄 Updated: ${article.title}`);
//           } else {
//             console.log(`⏩ Skipped (no change): ${article.title}`);
//           }
//         } else {
//           await prisma.scrapedItem.create({
//             data: {
//               sourceId: scrapeSource.id,
//               url: article.url,
//               canonicalUrl: article.url,
//               title: article.title,
//               authors: article.authors,
//               publishedAt: article.publishedAt,
//               excerpt: article.excerpt,
//               content: article.content,
//               contentHash,
//               tags: article.tags,
//               credibility,
//               scrapedMeta: article.scrapedMeta,
//               language: "en",
//             },
//           });
//           console.log(`✅ Saved positive article: ${article.title}`);
//         }

//         await new Promise((r) => setTimeout(r, 1500));
//       }
//     }

//     console.log(`✅ Wide scrape complete at ${now.toISOString()}\n`);
//   }
// }