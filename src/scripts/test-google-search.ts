/**
 * Konfam Brand Intelligence Scraper (DB Integrated)
 * -------------------------------------------------------
 * - Scrapes Google/News via SerpAPI
 * - Extracts full article content using Cheerio
 * - Analyzes sentiment and credibility
 * - Saves or updates results in PostgreSQL (via Prisma)
 * -------------------------------------------------------
 */

import fetch from "node-fetch";
import * as cheerio from "cheerio";
import * as dotenv from "dotenv";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

dotenv.config();
const prisma = new PrismaClient();

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
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

// ============================================================
// TYPES
// ============================================================
interface ArticleData {
  url: string;
  title: string;
  content: string;
  excerpt: string;
  authors: string[];
  publishedAt: Date | null;
  tags: string[];
  rawHtml: string;
  scrapedMeta: {
    source: string;
    thumbnail?: string;
    description?: string;
    category: string;
    sentimentIndicators?: {
      negative: string[];
      positive: string[];
    };
    wordCount: number;
    headings: string[];
    images: string[];
  };
}

// ============================================================
// SCRAPER CLASS
// ============================================================
class BrandIntelligenceScraper {
  private negativeKeywords = [
    "scam",
    "fraud",
    "complaint",
    "lawsuit",
    "illegal",
    "breach",
    "hack",
    "stolen",
    "loss",
    "fail",
    "poor",
    "bad",
    "terrible",
    "worst",
    "avoid",
    "warning",
    "alert",
    "crisis",
    "scandal",
    "corruption",
    "embezzlement",
    "theft",
    "negligence",
    "abuse",
  ];

  private positiveKeywords = [
    "award",
    "best",
    "excellent",
    "success",
    "growth",
    "innovation",
    "leader",
    "top",
    "great",
    "outstanding",
    "achievement",
    "win",
    "partnership",
    "expansion",
    "milestone",
    "recognized",
  ];

  private calculateCredibility(article: ArticleData): number {
    let score = 0.5;

    const trustedDomains = [
      "bbc.com",
      "reuters.com",
      "bloomberg.com",
      "ft.com",
      "theguardian.com",
      "cnn.com",
      "premiumtimesng.com",
      "punchng.com",
      "thecable.ng",
    ];
    const domain = new URL(article.url).hostname.replace("www.", "");
    if (trustedDomains.some((d) => domain.includes(d))) score += 0.3;
    if (article.authors.length > 0) score += 0.1;
    if (article.publishedAt) score += 0.1;

    const { negative, positive } =
      article.scrapedMeta.sentimentIndicators || { negative: [], positive: [] };
    if (negative.length > 3 && positive.length === 0) score -= 0.15;

    return Math.max(0, Math.min(1, score));
  }

  private generateContentHash(content: string): string {
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

  private async fetchArticleContent(
    url: string,
    category: string,
    source: string
  ): Promise<ArticleData | null> {
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
      api_key: CONFIG.SERPAPI_KEY,
      num: CONFIG.MAX_RESULTS_PER_SOURCE.toString(),
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

  // ============================================================
  // 🧠 MAIN SCRAPE CYCLE
  // ============================================================
  async runScrapeCycle(): Promise<void> {
    const now = new Date();

    // 1️⃣ Upsert ScrapeSource for this brand
    const scrapeSource = await prisma.scrapeSource.upsert({
      where: { name: `${CONFIG.BRAND_NAME} - Web Intelligence` },
      update: {
        lastCrawledAt: now,
        updatedAt: now,
        isActive: true,
      },
      create: {
        brandId: CONFIG.BRAND_ID,
        name: `${CONFIG.BRAND_NAME} - Web Intelligence`,
        baseUrl: "https://www.google.com",
        entryPaths: CONFIG.QUERIES.map((q) => q.query),
        type: "news",
        crawlInterval: CONFIG.SCRAPE_INTERVAL_MINUTES * 60,
        lastCrawledAt: now,
      },
    });

    console.log(`📡 Running scrape cycle for ${CONFIG.BRAND_NAME}...\n`);

    // 2️⃣ Process queries
    for (const queryConfig of CONFIG.QUERIES) {
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

        // 3️⃣ Check for existing article
        const existing = await prisma.scrapedItem.findUnique({
          where: { url: article.url },
        });

        if (existing) {
          // Update if contentHash changed
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
          // Create new entry
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

        await new Promise((r) => setTimeout(r, 1500)); // polite delay
      }
    }

    console.log(`\n✅ Scrape cycle complete at ${now.toISOString()}\n`);
  }

  async start() {
    console.log(`🚀 Brand Intelligence Scraper for ${CONFIG.BRAND_NAME}`);
    await this.runScrapeCycle();
    setInterval(
      () => this.runScrapeCycle(),
      CONFIG.SCRAPE_INTERVAL_MINUTES * 60 * 1000
    );
  }
}

// ============================================================
// MAIN EXECUTION
// ============================================================
(async () => {
  const scraper = new BrandIntelligenceScraper();
  await scraper.start();
})();

// import fetch from 'node-fetch';
// import * as cheerio from 'cheerio';
// import * as dotenv from 'dotenv';
// import crypto from 'crypto';

// dotenv.config();

// // Configuration
// const CONFIG = {
//   SERPAPI_KEY: process.env.SERPAPI_API_KEY || '',
//   BRAND_ID: 'brand_zenith_bank_001',
//   BRAND_NAME: 'Zenith Bank Nigeria',
//   MAX_RESULTS_PER_SOURCE: 3,
//   FETCH_FULL_CONTENT: true,
//   SCRAPE_INTERVAL_MINUTES: 60,
//   QUERIES: [
//     { type: 'news', query: 'Zenith Bank Nigeria', label: 'News Articles' },
//     { type: 'search', query: 'Zenith Bank Nigeria scam OR fraud OR complaint OR review', label: 'Complaints & Reviews' },
//     { type: 'search', query: 'Zenith Bank Nigeria lawsuit OR legal OR court', label: 'Legal Issues' },
//     { type: 'search', query: 'Zenith Bank Nigeria customer experience OR service', label: 'Customer Sentiment' }
//   ]
// };

// interface ArticleData {
//   url: string;
//   title: string;
//   content: string;
//   excerpt: string;
//   authors: string[];
//   publishedAt: Date | null;
//   tags: string[];
//   rawHtml: string;
//   scrapedMeta: {
//     source: string;
//     thumbnail?: string;
//     description?: string;
//     category: string;
//     sentimentIndicators?: {
//       negative: string[];
//       positive: string[];
//     };
//     wordCount: number;
//     headings: string[];
//     images: string[];
//   };
// }

// class BrandIntelligenceScraper {
//   private negativeKeywords = [
//     'scam', 'fraud', 'complaint', 'lawsuit', 'illegal', 'breach',
//     'hack', 'stolen', 'loss', 'fail', 'poor', 'bad', 'terrible',
//     'worst', 'avoid', 'warning', 'alert', 'crisis', 'scandal',
//     'corruption', 'embezzlement', 'theft', 'negligence', 'abuse'
//   ];

//   private positiveKeywords = [
//     'award', 'best', 'excellent', 'success', 'growth', 'innovation',
//     'leader', 'top', 'great', 'outstanding', 'achievement', 'win',
//     'partnership', 'expansion', 'milestone', 'recognized'
//   ];

//   private calculateCredibility(article: ArticleData): number {
//     let score = 0.5;

//     const trustedDomains = ['bbc.com', 'reuters.com', 'bloomberg.com', 'ft.com', 'theguardian.com', 'cnn.com', 'premiumtimesng.com', 'punchng.com', 'thecable.ng'];
//     const domain = new URL(article.url).hostname.replace('www.', '');
//     if (trustedDomains.some(d => domain.includes(d))) {
//       score += 0.3;
//     }

//     if (article.authors.length > 0) score += 0.1;
//     if (article.publishedAt) score += 0.1;

//     const { negative, positive } = article.scrapedMeta.sentimentIndicators || { negative: [], positive: [] };
//     if (negative.length > 3 && positive.length === 0) {
//       score -= 0.15;
//     }

//     return Math.max(0, Math.min(1, score));
//   }

//   private generateContentHash(content: string): string {
//     return crypto.createHash('sha256').update(content).digest('hex');
//   }

//   private extractAuthors($: cheerio.CheerioAPI): string[] {
//     const authors: string[] = [];
//     const selectors = [
//       'meta[name="author"]',
//       'meta[property="article:author"]',
//       '.author-name',
//       '.author',
//       '[rel="author"]',
//       '.byline'
//     ];

//     for (const selector of selectors) {
//       $(selector).each((_, el) => {
//         const content = $(el).attr('content') || $(el).text().trim();
//         if (content && content.length > 2 && content.length < 100) {
//           authors.push(content);
//         }
//       });
//     }

//     return [...new Set(authors)];
//   }

//   private extractPublishedDate($: cheerio.CheerioAPI): Date | null {
//     const selectors = [
//       'meta[property="article:published_time"]',
//       'meta[name="publication_date"]',
//       'meta[name="date"]',
//       'time[datetime]',
//       '.published-date',
//       '.post-date'
//     ];

//     for (const selector of selectors) {
//       const el = $(selector).first();
//       const dateStr = el.attr('content') || el.attr('datetime') || el.text().trim();
      
//       if (dateStr) {
//         const date = new Date(dateStr);
//         if (!isNaN(date.getTime())) {
//           return date;
//         }
//       }
//     }

//     return null;
//   }

//   private extractCanonicalUrl($: cheerio.CheerioAPI, url: string): string {
//     const canonical = $('link[rel="canonical"]').attr('href');
//     return canonical || url;
//   }

//   private analyzeSentiment(text: string): { negative: string[]; positive: string[] } {
//     const lowerText = text.toLowerCase();
    
//     const negative = this.negativeKeywords.filter(keyword => 
//       lowerText.includes(keyword)
//     );
    
//     const positive = this.positiveKeywords.filter(keyword => 
//       lowerText.includes(keyword)
//     );

//     return { negative, positive };
//   }

//   private async fetchArticleContent(
//     url: string,
//     category: string,
//     source: string
//   ): Promise<ArticleData | null> {
//     try {
//       const response = await fetch(url, {
//         headers: {
//           'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
//         },
//         timeout: 10000
//       });

//       if (!response.ok) return null;

//       const html = await response.text();
//       const $ = cheerio.load(html);

//       const title = $('meta[property="og:title"]').attr('content') || 
//                    $('title').text() || 
//                    $('h1').first().text() || 
//                    'Untitled';

//       const description = $('meta[property="og:description"]').attr('content') || 
//                          $('meta[name="description"]').attr('content') || 
//                          '';

//       const thumbnail = $('meta[property="og:image"]').attr('content') || '';

//       const authors = this.extractAuthors($);
//       const publishedAt = this.extractPublishedDate($);
//       const canonicalUrl = this.extractCanonicalUrl($, url);

//       $('script, style, nav, header, footer, aside, .ad, .advertisement, .cookie, .popup').remove();

//       const headings: string[] = [];
//       $('h1, h2, h3, h4, h5, h6').each((_, el) => {
//         const text = $(el).text().trim();
//         if (text && text.length > 3) headings.push(text);
//       });

//       const paragraphs: string[] = [];
//       const selectors = [
//         'article p', '.article-body p', '.article-content p',
//         '.post-content p', '.entry-content p', 'main p', '.content p'
//       ];

//       for (const selector of selectors) {
//         $(selector).each((_, el) => {
//           const text = $(el).text().trim();
//           if (text && text.length > 100) {
//             paragraphs.push(text);
//           }
//         });
//         if (paragraphs.length > 0) break;
//       }

//       if (paragraphs.length === 0) {
//         $('p').each((_, el) => {
//           const text = $(el).text().trim();
//           if (text && text.length > 100) {
//             paragraphs.push(text);
//           }
//         });
//       }

//       const images: string[] = [];
//       $('article img, .article-body img, .content img, main img').each((_, el) => {
//         const src = $(el).attr('src') || $(el).attr('data-src');
//         if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('avatar')) {
//           try {
//             const fullSrc = src.startsWith('http') ? src : new URL(src, url).href;
//             images.push(fullSrc);
//           } catch (e) {}
//         }
//       });

//       const content = paragraphs.join('\n\n');
//       const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;

//       if (wordCount < 50) return null;

//       const sentimentIndicators = this.analyzeSentiment(content);

//       const tags = [...new Set([
//         ...sentimentIndicators.negative,
//         ...sentimentIndicators.positive,
//         category.toLowerCase().replace(/\s+/g, '-')
//       ])];

//       return {
//         url: canonicalUrl,
//         title: title.trim(),
//         content,
//         excerpt: description.substring(0, 500),
//         authors,
//         publishedAt,
//         tags,
//         rawHtml: html,
//         scrapedMeta: {
//           source,
//           thumbnail,
//           description,
//           category,
//           sentimentIndicators,
//           wordCount,
//           headings,
//           images: [...new Set(images)]
//         }
//       };
//     } catch (error) {
//       return null;
//     }
//   }

//   private async searchSource(
//     query: string,
//     type: string,
//     label: string,
//     maxResults: number
//   ): Promise<{ url: string; source: string; category: string }[]> {
//     if (!CONFIG.SERPAPI_KEY) {
//       throw new Error('Missing SerpAPI key. Please set SERPAPI_API_KEY environment variable.');
//     }

//     const params = new URLSearchParams({
//       engine: 'google',
//       q: query,
//       api_key: CONFIG.SERPAPI_KEY,
//       num: maxResults.toString(),
//       ...(type === 'news' && { tbm: 'nws' })
//     });

//     const url = `https://serpapi.com/search?${params.toString()}`;

//     try {
//       const response = await fetch(url);
//       const data: any = await response.json();

//       if (data.error) {
//         throw new Error(`SerpAPI Error: ${data.error}`);
//       }

//       const results = data.news_results || data.organic_results || [];

//       return results.map((item: any) => ({
//         url: item.link,
//         source: item.source || item.displayed_link || new URL(item.link).hostname,
//         category: label
//       }));
//     } catch (error) {
//       return [];
//     }
//   }

//   async runScrapeCycle(): Promise<void> {
//     const cycleStartTime = new Date();

//     // Simulate ScrapeSource upsert
//     const scrapeSourceData = {
//       model: 'ScrapeSource',
//       operation: 'upsert',
//       where: { name: `${CONFIG.BRAND_NAME} - Web Intelligence` },
//       data: {
//         id: `source_${Date.now()}`,
//         brandId: CONFIG.BRAND_ID,
//         name: `${CONFIG.BRAND_NAME} - Web Intelligence`,
//         baseUrl: 'https://www.google.com',
//         entryPaths: CONFIG.QUERIES.map(q => q.query),
//         type: 'news',
//         crawlInterval: CONFIG.SCRAPE_INTERVAL_MINUTES * 60,
//         isActive: true,
//         lastCrawledAt: cycleStartTime,
//         createdAt: cycleStartTime,
//         updatedAt: cycleStartTime
//       }
//     };

//     console.log('\n' + '═'.repeat(80));
//     console.log('🗄️  DATABASE OPERATION - ScrapeSource');
//     console.log('═'.repeat(80));
//     console.log(JSON.stringify(scrapeSourceData, null, 2));
//     console.log('═'.repeat(80) + '\n');

//     // Process each query
//     for (const queryConfig of CONFIG.QUERIES) {
//       const searchResults = await this.searchSource(
//         queryConfig.query,
//         queryConfig.type,
//         queryConfig.label,
//         CONFIG.MAX_RESULTS_PER_SOURCE
//       );

//       for (const result of searchResults) {
//         const article = await this.fetchArticleContent(
//           result.url,
//           result.category,
//           result.source
//         );

//         if (!article) continue;

//         const credibility = this.calculateCredibility(article);
//         const contentHash = this.generateContentHash(article.content);

//         // Simulate ScrapedItem creation
//         const scrapedItemData = {
//           model: 'ScrapedItem',
//           operation: 'create',
//           data: {
//             id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
//             sourceId: scrapeSourceData.data.id,
//             url: article.url,
//             canonicalUrl: article.url,
//             title: article.title,
//             authors: article.authors,
//             publishedAt: article.publishedAt,
//             fetchedAt: new Date(),
//             excerpt: article.excerpt,
//             content: article.content,
//             contentHash,
//             language: 'en',
//             rawHtml: `[HTML Content - ${article.rawHtml.length} bytes]`,
//             tags: article.tags,
//             credibility,
//             scrapedMeta: article.scrapedMeta,
//             createdAt: new Date(),
//             updatedAt: new Date()
//           }
//         };

//         console.log('\n' + '═'.repeat(80));
//         console.log('🗄️  DATABASE OPERATION - ScrapedItem');
//         console.log('═'.repeat(80));
//         console.log(JSON.stringify(scrapedItemData, null, 2));
//         console.log('═'.repeat(80) + '\n');

//         // Rate limiting
//         await new Promise(resolve => setTimeout(resolve, 1500));
//       }
//     }
//   }

//   async start(): Promise<void> {
//     console.log('\n🚀 Starting Automated Brand Intelligence Scraper');
//     console.log(`📊 Brand: ${CONFIG.BRAND_NAME}`);
//     console.log(`⏰ Interval: Every ${CONFIG.SCRAPE_INTERVAL_MINUTES} minutes`);
//     console.log(`🔑 Brand ID: ${CONFIG.BRAND_ID}`);
//     console.log('\n' + '─'.repeat(80) + '\n');

//     // Run first cycle immediately
//     await this.runScrapeCycle();

//     // Schedule subsequent cycles
//     setInterval(async () => {
//       console.log(`\n⏰ [${new Date().toISOString()}] Starting new scrape cycle...\n`);
//       await this.runScrapeCycle();
//     }, CONFIG.SCRAPE_INTERVAL_MINUTES * 60 * 1000);

//     console.log(`\n✅ Scraper is running. Next cycle in ${CONFIG.SCRAPE_INTERVAL_MINUTES} minutes...`);
//   }
// }

// // Main execution
// async function main() {
//   const scraper = new BrandIntelligenceScraper();
//   await scraper.start();
// }

// if (require.main === module) {
//   main().catch(error => {
//     console.error('Fatal error:', error);
//     process.exit(1);
//   });
// }

// export default BrandIntelligenceScraper;


// // /**
// //  * test-google-scrape.ts
// //  * ------------------------------------------------------------
// //  * Step 2 of web intelligence pipeline:
// //  * - Uses Google Custom Search API to find recent Zenith Bank pages
// //  * - Crawls each link to extract title, date, and full main content
// //  * ------------------------------------------------------------
// //  */

// // import * as cheerio from "cheerio";
// // import dotenv from "dotenv";

// // dotenv.config();

// // const API_KEY = process.env.GOOGLE_SEARCH_API_KEY!;
// // const CX = process.env.GOOGLE_SEARCH_CX!;

// // // 🔹 Search query (only recent Zenith Bank content)
// // const QUERY = `"Zenith Bank" (news OR report OR headline) site:.ng OR site:.com after:2025-01-01`;

// // // ------------------------------------------------------------
// // // 🔍 Google Search
// // // ------------------------------------------------------------
// // async function googleSearch(query: string, start = 1) {
// //   const url = new URL("https://www.googleapis.com/customsearch/v1");
// //   url.searchParams.set("key", API_KEY);
// //   url.searchParams.set("cx", CX);
// //   url.searchParams.set("q", query);
// //   url.searchParams.set("num", "10");
// //   url.searchParams.set("start", String(start));
// //   url.searchParams.set("sort", "date");

// //   const res = await fetch(url);
// //   if (!res.ok) throw new Error(`Google API error: ${res.status}`);
// //   const data = await res.json();
// //   return data.items || [];
// // }

// // // ------------------------------------------------------------
// // // 🧾 Fetch and parse article content
// // // ------------------------------------------------------------
// // async function fetchArticle(url: string) {
// //   const controller = new AbortController();
// //   const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

// //   try {
// //     const res = await fetch(url, {
// //       headers: {
// //         "User-Agent": "Mozilla/5.0 (KonfamBot/1.0; +https://konfam.ai)",
// //         Accept: "text/html",
// //       },
// //       signal: controller.signal,
// //     });

// //     clearTimeout(timeout);

// //     if (!res.ok) {
// //       console.warn(`⚠️ Failed to fetch ${url}: HTTP ${res.status}`);
// //       return null;
// //     }

// //     const html = await res.text();
// //     const $ = cheerio.load(html);

// //     // 📰 Title
// //     const title =
// //       $("meta[property='og:title']").attr("content") ||
// //       $("title").text().trim() ||
// //       "Untitled Article";

// //     // 📅 Date
// //     const date =
// //       $("meta[property='article:published_time']").attr("content") ||
// //       $("meta[name='date']").attr("content") ||
// //       $("time").attr("datetime") ||
// //       $("time").text().trim() ||
// //       null;

// //     // 🧠 Extract text body (fallbacks)
// //     let content =
// //       $("article").text() ||
// //       $("main").text() ||
// //       $("div[class*='content']").text() ||
// //       $("body").text();

// //     const cleanText = content
// //       .replace(/\s+/g, " ")
// //       .replace(/Read also:.*/gi, "")
// //       .replace(/Copyright.*/gi, "")
// //       .trim();

// //     // ⚙️ Optional filter — only keep Zenith-related content
// //     if (!cleanText.toLowerCase().includes("zenith")) {
// //       console.log(`⏩ Skipping — no Zenith reference found.`);
// //       return null;
// //     }

// //     // 🚀 Display full text content clearly
// //     console.log(`\n🧾 Fetched: ${title}`);
// //     if (date) console.log(`📅 Date: ${date}`);
// //     console.log(`🌐 URL: ${url}`);
// //     console.log(`📰 Full Content:\n${cleanText}\n`);
// //     console.log("------------------------------------------------------------");

// //     return { title, date, text: cleanText, url };
// //   } catch (err: any) {
// //     if (err.name === "AbortError") {
// //       console.warn(`⏱️ Timeout fetching ${url}`);
// //     } else {
// //       console.warn(`❌ Error fetching ${url}: ${err.message}`);
// //     }
// //     return null;
// //   } finally {
// //     clearTimeout(timeout);
// //   }
// // }

// // // ------------------------------------------------------------
// // // 🚀 Run
// // // ------------------------------------------------------------
// // (async () => {
// //   console.log(`🔎 Searching Google for: ${QUERY}\n`);

// //   const results = await googleSearch(QUERY);
// //   console.log(`✅ Found ${results.length} search results\n`);

// //   for (const item of results) {
// //     console.log(`🌐 ${item.title}`);
// //     console.log(`🔗 ${item.link}`);
// //     console.log(`🧠 ${item.snippet}\n`);

// //     // Delay slightly between requests (avoid 429 rate limit)
// //     await new Promise((r) => setTimeout(r, 1200));

// //     await fetchArticle(item.link);
// //   }

// //   console.log(`\n✅ Scraping test complete.`);
// // })();