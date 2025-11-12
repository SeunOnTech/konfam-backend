import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Connecting to database...");
  await prisma.$connect();
  console.log("Connected to database");

  // Quick test: count SourcePost entries
  const postCount = await prisma.sourcePost.count();
  console.log(`Total SourcePosts in DB: ${postCount}`);

  // Optional: create a sample post
  const newPost = await prisma.sourcePost.create({
    data: {
      externalId: "post_001",
      authorId: "user_001",
      content: "This is a test post from Konfam setup",
      language: "ENGLISH",
      createdAt: new Date(),
    },
  });
  console.log("Created new SourcePost:", newPost);

  await prisma.$disconnect();
  console.log("🔌 Disconnected successfully");
}

main().catch((err) => {
  console.error("Prisma test failed:", err);
  prisma.$disconnect();
});
