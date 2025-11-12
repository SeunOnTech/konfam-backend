// seed-scraper-sources.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding scrape sources for Zenith Bank…");

  const brand = await prisma.brand.findUnique({
    where: { name: "Zenith Bank" },
    select: { id: true },
  });
  if (!brand) {
    throw new Error("Brand “Zenith Bank” not found. Please seed it first.");
  }

  
  
const sources = [
  // ✅ Official / first-party
  {
    name: "Zenith Bank – News & Updates",
    baseUrl: "https://www.zenithbank.com",
    entryPaths: ["/investor-relations", "/media/news"],                // CORRECTED: Added trailing slash
    type: "news",
    cssSelector: "article a, .news-listing a, h2 a, h3 a",
    rssUrl: null,
    crawlInterval: 3600,
  },
  
  // ✅ Tier-1 Nigerian business media
  {
    name: "BusinessDay – Banking & Finance",
    baseUrl: "https://businessday.ng",
    entryPaths: ["/category/banking/"],           // CORRECTED: Changed from /banking-finance/
    type: "news",
    cssSelector: "article h2 a, .entry-title a, h3 a",
    rssUrl: null,
    crawlInterval: 7200,
  },
  {
    name: "Vanguard – Banking & Finance Coverage",
    baseUrl: "https://www.vanguardngr.com",
    entryPaths: ["/category/business/", "/tag/zenith-bank/"],  // CORRECTED: Vanguard doesn't have specific zenith-bank tag page that's accessible
    type: "news",
    cssSelector: "h3 a, .entry-title a, .jeg_post_title a, article h2 a",
    rssUrl: null,
    crawlInterval: 7200,
  },
  {
    name: "The Guardian Nigeria – Business & Money",
    baseUrl: "https://guardian.ng",
    entryPaths: ["/category/business-services/business/", "/category/business-services/money/"],  // CORRECTED: Full category paths
    type: "news",
    cssSelector: "h2 a, h3 a, .news__item a, article h2 a",
    rssUrl: null,
    crawlInterval: 7200,
  },
  {
    name: "Premium Times – Business",
    baseUrl: "https://www.premiumtimesng.com",
    entryPaths: ["/category/business"],
    type: "news",
    cssSelector: "h3.entry-title a, article h2 a, .entry-title a",
    rssUrl: null,
    crawlInterval: 7200,
  },
  {
    name: "TheCable – Business",
    baseUrl: "https://www.thecable.ng",
    entryPaths: ["/category/business"],           // CORRECTED: Removed /section
    type: "news",
    cssSelector: "h2.post-title a, article h2 a, .entry-title a",
    rssUrl: null,
    crawlInterval: 7200,
  },
  {
    name: "Channels TV – Business News",
    baseUrl: "https://www.channelstv.com",
    entryPaths: ["/category/business/"],          // CORRECTED: Added proper business category
    type: "news",
    cssSelector: ".post-content h2 a, article h2 a, .entry-title a",
    rssUrl: null,
    crawlInterval: 7200,
  },
  
  // ✅ Market / regulator
  {
    name: "Nigerian Exchange (NGX) – News & Press",
    baseUrl: "https://ngxgroup.com",
    entryPaths: ["/"],                            // CORRECTED: Main page, news is integrated
    type: "press",
    cssSelector: "article h2 a, .posts-list a, .news-item a",
    rssUrl: null,
    crawlInterval: 14400,
  },
  
  // ✅ Focused Zenith coverage on reputable site
  {
    name: "Nairametrics – Zenith Bank Coverage",
    baseUrl: "https://nairametrics.com",
    entryPaths: ["/tag/zenith-bank-plc/", "/?s=zenith+bank"],  // CORRECTED: Actual tag path from stocks subdomain
    type: "news",
    cssSelector: "article h2 a, .jeg_post_title a, .entry-title a",
    rssUrl: null,
    crawlInterval: 7200,
  },
];
  

// const sources = [
//   {
//     name: "Zenith Bank – Investor Relations / Press Releases",
//     baseUrl: "https://www.zenithbank.com",
//     entryPaths: ["/investor-relations", "/media/news"],
//     type: "news",
//     cssSelector: "a.press-release-item, div.news-listing a",
//     rssUrl: null,
//     crawlInterval: 3600,
//   },
//   {
//     name: "Nairametrics – Business & Banking News",
//     baseUrl: "https://www.nairametrics.com",
//     entryPaths: ["/tag/zenith-bank/"],
//     type: "news",
//     cssSelector: "div.post-listing a.title",
//     rssUrl: null,
//     crawlInterval: 7200,
//   },
//   {
//     name: "PUNCH Nigeria – Banking & Finance Section",
//     baseUrl: "https://www.punchng.com",
//     entryPaths: ["/business/banking-finance/"],
//     type: "news",
//     cssSelector: "h3.post-title a, .entry-title a",
//     rssUrl: null,
//     crawlInterval: 7200,
//   },
//   {
//     name: "Vanguard Nigeria – Zenith Bank Tag",
//     baseUrl: "https://www.vanguardngr.com",
//     entryPaths: ["/tag/zenith-bank/"],
//     type: "news",
//     cssSelector: "div.views-row a",
//     rssUrl: null,
//     crawlInterval: 7200,
//   },
//   {
//     name: "BusinessDay Nigeria – Banking Sector",
//     baseUrl: "https://businessday.ng",
//     entryPaths: ["/category/banking-finance/"],
//     type: "news",
//     cssSelector: "article.post h2 a, .bd-archive-listing a",
//     rssUrl: null,
//     crawlInterval: 7200,
//   },
//   {
//     name: "The Guardian Nigeria – Nigerian Banks Tag",
//     baseUrl: "https://guardian.ng",
//     entryPaths: ["/tag/nigerian-banks/"],
//     type: "news",
//     cssSelector: "h2.story-title a, ._3rJnC17u a",
//     rssUrl: null,
//     crawlInterval: 7200,
//   },
//   {
//     name: "Premium Times – Banking & Finance Section",
//     baseUrl: "https://www.premiumtimesng.com",
//     entryPaths: ["/business/banking-finance/"],
//     type: "news",
//     cssSelector: "ul.article-listing a, div.story-title a",
//     rssUrl: null,
//     crawlInterval: 7200,
//   },
//   {
//     name: "Proshare – Business & Financial Headlines Nigeria",
//     baseUrl: "https://proshare.co",
//     entryPaths: ["/business", "/finance"],
//     type: "news",
//     cssSelector: "div.bn-list-item a, article h2 a",
//     rssUrl: null,
//     crawlInterval: 7200,
//   },
//   {
//     name: "The Banker – Nigeria Banking Insight",
//     baseUrl: "https://www.thebanker.com",
//     entryPaths: ["/World/Africa/Nigeria"],
//     type: "news",
//     cssSelector: "h3.title a, .article-details a",
//     rssUrl: null,
//     crawlInterval: 86400,
//   },
// ];


for (const src of sources) {
  await prisma.scrapeSource.upsert({
    where: { name: src.name },
    update: {
      baseUrl: src.baseUrl,
      entryPaths: src.entryPaths,
      type: src.type,
      cssSelector: src.cssSelector,
      rssUrl: src.rssUrl,
      crawlInterval: src.crawlInterval,
      isActive: true,
      updatedAt: new Date(),
    },
    create: {
      brandId: brand.id, 
      name: src.name,
      baseUrl: src.baseUrl,
      entryPaths: src.entryPaths,
      type: src.type,
      cssSelector: src.cssSelector,
      rssUrl: src.rssUrl,
      crawlInterval: src.crawlInterval,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  console.log(`✅ Upserted source: ${src.name}`);
}


  console.log("🌿 Seed complete for ScrapeSources.");
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("❌ Seeding scrape‐sources failed:", err);
    prisma.$disconnect();
    process.exit(1);
  });
