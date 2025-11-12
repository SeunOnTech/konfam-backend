/**
 * seed-demo-data.ts
 * ------------------------------------------------------------
 * Seeds demo client, brand, user, and monitor
 * for testing the Konfam detection pipeline.
 * Automatically hashes the admin password.
 * ------------------------------------------------------------
 */

import { PrismaClient, ClientTier, Platform, UserRole } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding demo Konfam data...");

  // 1️⃣ Define default login credentials
  const adminEmail = "admin@demo.com";
  const plainPassword = "DemoPass123!"; 
  const passwordHash = await bcrypt.hash(plainPassword, 10);

  // 2️⃣ Client
  const client = await prisma.client.upsert({
    where: { name: "Demo Client" },
    update: {},
    create: {
      name: "Demo Client",
      industry: "Banking",
      tier: ClientTier.PRO,
      subscriptionStatus: "ACTIVE",
      monthlyPostLimit: 2000,
    },
  });

  // 3️⃣ Brand
  const brand = await prisma.brand.upsert({
    where: { name: "Zenith Bank" },
    update: {},
    create: {
      clientId: client.id,
      name: "Zenith Bank",
      description: "Monitoring online reputation and feedback for Zenith Bank.",
      industry: "Banking",
      officialTwitterHandle: "@zenithbank",
      websiteUrl: "https://www.zenithbank.com",
      brandTone: "PROFESSIONAL",
    },
  });

  // 4️⃣ User (Admin)
  const user = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      passwordHash, // 🔄 always refresh hash to ensure login consistency
    },
    create: {
      clientId: client.id,
      email: adminEmail,
      passwordHash,
      firstName: "Demo",
      lastName: "Admin",
      role: UserRole.ADMIN,
      isActive: true,
    },
  });

  // 5️⃣ Monitor
  const monitor = await prisma.monitor.upsert({
    where: { name: "Zenith Bank Watch" },
    update: {},
    create: {
      brandId: brand.id,
      name: "Zenith Bank Watch",
      platform: Platform.X_CLONE,
      keywords: ["zenith", "zenithbank", "@zenithbank", "#zenithbank", "zenith bank"],
      excludeKeywords: ["not a scam", "resolved", "great service"],
      sentimentThreshold: -0.3,
      viralityThreshold: 2.0,
      engagementThreshold: 10,
      isActive: true,
      checkIntervalSeconds: 30,
    },
  });

  console.log(`✅ Seed complete:
  • Client: ${client.name}
  • Brand: ${brand.name}
  • Monitor: ${monitor.name}
  • User: ${user.email}
  • Login password: ${plainPassword}
  `);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("❌ Seeding failed:", err);
    prisma.$disconnect();
    process.exit(1);
  });
