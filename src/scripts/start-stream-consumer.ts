// ============================================================================
// FILE: src/scripts/start-stream-consumer.ts
// Stream Consumer - Listens to filtered stream and logs matched posts
// ============================================================================

import dotenv from 'dotenv';

dotenv.config();

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";

interface StreamPost {
  id: string;
  content: string;
  language: string;
  emotionalTone: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  viewCount: number;
  createdAt: string;
}

interface MatchedRule {
  id: string;
  name: string;
  keywords: string[];
}

interface StreamData {
  status?: string;
  post?: StreamPost;
  matchedRules?: MatchedRule[];
  timestamp?: string;
}

async function consumeStream() {
  console.log("🔌 Konfam: Connecting to X Clone filtered stream...");
  console.log(`   Target: ${BACKEND_URL}/api/filtered-stream\n`);
  
  console.log("🚀 Konfam Stream Consumer Starting...");
  console.log("Press Ctrl+C to stop\n");

  try {
    const response = await fetch(`${BACKEND_URL}/api/filtered-stream`, {
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("No response body available");
    }

    console.log("✅ Konfam: Connected to X Clone stream!");
    console.log("👂 Listening for matched posts...\n");
    console.log("=".repeat(70) + "\n");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let postCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        console.log("\n❌ Stream ended unexpectedly");
        break;
      }

      // Decode chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete messages (SSE format: "data: {...}\n\n")
      const messages = buffer.split('\n\n');
      buffer = messages.pop() || ''; // Keep incomplete message in buffer

      for (const message of messages) {
        if (!message.trim()) continue;

        // Extract data from SSE format
        const lines = message.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const jsonStr = line.substring(5).trim(); // Remove "data:" prefix
            
            if (!jsonStr) continue;

            try {
              const data: StreamData = JSON.parse(jsonStr);
              
              // Handle connection status
              if (data.status === 'connected') {
                console.log("🎉 Stream connection established and ready\n");
                continue;
              }

              // Handle matched post
              if (data.post && data.matchedRules) {
                postCount++;
                
                console.log(`📨 POST #${postCount} MATCHED`);
                console.log("─".repeat(70));
                console.log(`👤 Author: @${data.post.author.username} (${data.post.author.displayName})`);
                console.log(`📝 Content: "${data.post.content}"`);
                console.log(`🌐 Language: ${data.post.language}`);
                console.log(`😊 Tone: ${data.post.emotionalTone}`);
                console.log(`\n📊 Engagement:`);
                console.log(`   ❤️  Likes: ${data.post.likeCount}`);
                console.log(`   🔄 Retweets: ${data.post.retweetCount}`);
                console.log(`   💬 Replies: ${data.post.replyCount}`);
                console.log(`   👀 Views: ${data.post.viewCount}`);
                console.log(`\n🎯 Matched Rules (${data.matchedRules.length}):`);
                
                data.matchedRules.forEach((rule, idx) => {
                  console.log(`   ${idx + 1}. ${rule.name}`);
                  console.log(`      Keywords: [${rule.keywords.join(', ')}]`);
                });
                
                console.log(`\n🕐 Timestamp: ${new Date(data.timestamp!).toLocaleString()}`);
                console.log(`🆔 Post ID: ${data.post.id}`);
                console.log("=".repeat(70) + "\n");
              }
              
            } catch (err) {
              console.error("⚠️ Failed to parse message:", err);
              console.error("   Raw data:", jsonStr.substring(0, 100));
            }
          }
        }
      }
    }

  } catch (error: any) {
    console.error("\n❌ Stream Error:", error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.error("\n💡 TIP: Make sure your backend server is running!");
      console.error(`   Expected at: ${BACKEND_URL}`);
    } else if (error.message.includes('404')) {
      console.error("\n💡 TIP: Check that the /api/filtered-stream endpoint exists");
    } else if (error.message.includes('500')) {
      console.error("\n💡 TIP: Check server logs for errors");
    }
    
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log("\n\n👋 Stream consumer stopped by user");
  console.log("Goodbye!\n");
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log("\n\n👋 Stream consumer terminated");
  process.exit(0);
});

// Start consuming
console.clear();
consumeStream().catch((error) => {
  console.error("\n💥 Fatal Error:", error);
  process.exit(1);
});

// import '../services/stream-consumer';

// console.log("🚀 Konfam Stream Consumer Starting...\n");
// console.log("Press Ctrl+C to stop\n");

// // Keep process alive
// process.on('SIGINT', () => {
//   console.log("\n\n👋 Shutting down Konfam stream consumer...");
//   process.exit(0);
// });