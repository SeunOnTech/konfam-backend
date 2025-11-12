/**
 * BrandIntelligenceService
 * ------------------------------------------------------------
 * Extracted from your working script (100 % logic preserved)
 * Can be triggered manually or via BullMQ queue.
 * ------------------------------------------------------------
 */

import fetch from "node-fetch";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";

dotenv.config();
const prisma = new PrismaClient();

export class BrandIntelligenceService {
  private CONFIG = {
    SERPAPI_KEY: process.env.SERPAPI_API_KEY || "",
    BRAND_ID: "cmhv9nskc0002uu3cl92dyovn",
    BRAND_NAME: "Zenith Bank Nigeria",
    MAX_RESULTS_PER_SOURCE: 3,
    FETCH_FULL_CONTENT: true,
    SCRAPE_INTERVAL_MINUTES: 60,
    QUERIES: [
      { type: "news", query: "Zenith Bank Nigeria", label: "News Articles" },
      {
        type: "search",
        query: "Zenith Bank Nigeria scam OR fraud OR complaint OR review",
        label: "Complaints & Reviews",
      },
      {
        type: "search",
        query: "Zenith Bank Nigeria lawsuit OR legal OR court",
        label: "Legal Issues",
      },
      {
        type: "search",
        query: "Zenith Bank Nigeria customer experience OR service",
        label: "Customer Sentiment",
      },
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
    "milestone","recognized",
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

    const { negative, positive } =
      article.scrapedMeta.sentimentIndicators || { negative: [], positive: [] };
    if (negative.length > 3 && positive.length === 0) score -= 0.15;

    return Math.max(0, Math.min(1, score));
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
        if (content && content.length > 2 && content.length < 100)
          authors.push(content);
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
        el.attr("content") || el.attr("datetime") || el.text().trim();
      if (dateStr) {
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) return date;
      }
    }
    return null;
  }

  private extractCanonicalUrl($: cheerio.CheerioAPI, url: string): string {
    const canonical = $('link[rel="canonical"]').attr("href");
    return canonical || url;
  }

  private analyzeSentiment(text: string) {
    const lowerText = text.toLowerCase();
    const negative = this.negativeKeywords.filter((kw) =>
      lowerText.includes(kw)
    );
    const positive = this.positiveKeywords.filter((kw) =>
      lowerText.includes(kw)
    );
    return { negative, positive };
  }

  private async fetchArticleContent(url: string, category: string, source: string) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (KonfamBot/1.0)" },
        timeout: 10000,
      });
      if (!response.ok) return null;

      const html = await response.text();
      const $ = cheerio.load(html);

      const title =
        $('meta[property="og:title"]').attr("content") ||
        $("title").text() ||
        $("h1").first().text() ||
        "Untitled";

      const description =
        $('meta[property="og:description"]').attr("content") ||
        $('meta[name="description"]').attr("content") ||
        "";

      const thumbnail = $('meta[property="og:image"]').attr("content") || "";
      const authors = this.extractAuthors($);
      const publishedAt = this.extractPublishedDate($);
      const canonicalUrl = this.extractCanonicalUrl($, url);

      $("script, style, nav, header, footer, aside, .ad, .popup").remove();

      const headings: string[] = [];
      $("h1,h2,h3,h4,h5,h6").each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 3) headings.push(text);
      });

      const paragraphs: string[] = [];
      $("article p, main p, .content p").each((_, el) => {
        const text = $(el).text().trim();
        if (text && text.length > 100) paragraphs.push(text);
      });

      const content = paragraphs.join("\n\n");
      if (content.split(/\s+/).length < 50) return null;

      const sentimentIndicators = this.analyzeSentiment(content);
      const tags = [
        ...sentimentIndicators.negative,
        ...sentimentIndicators.positive,
        category.toLowerCase().replace(/\s+/g, "-"),
      ];

      return {
        url: canonicalUrl,
        title: title.trim(),
        content,
        excerpt: description.substring(0, 500),
        authors,
        publishedAt,
        tags,
        rawHtml: html,
        scrapedMeta: {
          source,
          thumbnail,
          description,
          category,
          sentimentIndicators,
          wordCount: content.split(/\s+/).length,
          headings,
          images: [],
        },
      };
    } catch {
      return null;
    }
  }

  private async searchSource(query: string, type: string, label: string) {
    const params = new URLSearchParams({
      engine: "google",
      q: query,
      api_key: this.CONFIG.SERPAPI_KEY,
      num: this.CONFIG.MAX_RESULTS_PER_SOURCE.toString(),
      ...(type === "news" && { tbm: "nws" }),
    });

    const res = await fetch(`https://serpapi.com/search?${params.toString()}`);
    const data = await res.json();
    const results = data.news_results || data.organic_results || [];

    return results.map((r: any) => ({
      url: r.link,
      source: r.source || r.displayed_link || new URL(r.link).hostname,
      category: label,
    }));
  }

  async runScrapeCycle() {
    const now = new Date();
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

    console.log(`📡 Running scrape cycle for ${this.CONFIG.BRAND_NAME}...\n`);

    for (const queryConfig of this.CONFIG.QUERIES) {
      const searchResults = await this.searchSource(
        queryConfig.query,
        queryConfig.type,
        queryConfig.label
      );

      for (const result of searchResults) {
        const article = await this.fetchArticleContent(
          result.url,
          result.category,
          result.source
        );
        if (!article) continue;

        const contentHash = this.generateContentHash(article.content);
        const credibility = this.calculateCredibility(article);

        const existing = await prisma.scrapedItem.findUnique({
          where: { url: article.url },
        });

        if (existing) {
          if (existing.contentHash !== contentHash) {
            await prisma.scrapedItem.update({
              where: { id: existing.id },
              data: {
                title: article.title,
                authors: article.authors,
                excerpt: article.excerpt,
                content: article.content,
                contentHash,
                tags: article.tags,
                credibility,
                scrapedMeta: article.scrapedMeta,
                updatedAt: now,
              },
            });
            console.log(`🔄 Updated: ${article.title}`);
          } else {
            console.log(`⏩ Skipped (no change): ${article.title}`);
          }
        } else {
          await prisma.scrapedItem.create({
            data: {
              sourceId: scrapeSource.id,
              url: article.url,
              canonicalUrl: article.url,
              title: article.title,
              authors: article.authors,
              publishedAt: article.publishedAt,
              excerpt: article.excerpt,
              content: article.content,
              contentHash,
              tags: article.tags,
              credibility,
              scrapedMeta: article.scrapedMeta,
              language: "en",
            },
          });
          console.log(`✅ Saved new: ${article.title}`);
        }

        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    console.log(`✅ Scrape cycle complete at ${now.toISOString()}\n`);
  }
}
