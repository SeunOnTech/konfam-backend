// konfam-backend/src/services/stream-consumer.ts

const X_CLONE_URL = process.env.XCLONE_API_URL || "http://localhost:4000";

export class XCloneStreamConsumer {
  private isConnected = false;

  async connect() {
    console.log("🔌 Konfam: Connecting to X Clone filtered stream...");
    console.log(`   Target: ${X_CLONE_URL}/api/filtered-stream\n`);

    try {
      const response = await fetch(`${X_CLONE_URL}/api/filtered-stream`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      this.isConnected = true;
      console.log("✅ Konfam: Connected to X Clone stream!\n");
      console.log("👂 Listening for matched posts...\n");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No response body");
      }

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          console.log("⚠️ Konfam: Stream ended");
          this.isConnected = false;
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        
        for (const line of lines) {
          if (line.startsWith("data:")) {
            const jsonStr = line.replace("data: ", "").trim();
            if (!jsonStr) continue;
            
            try {
              const data = JSON.parse(jsonStr);
              
              if (data.status === "connected") {
                console.log("🎉 Konfam: Stream connection established\n");
              } else if (data.post) {
                await this.handleIncomingPost(data);
              }
            } catch (err) {
              console.error("❌ Konfam: Parse error:", err);
            }
          }
        }
      }
    } catch (error) {
      this.isConnected = false;
      console.error("❌ Konfam: Connection error:", error);
      throw error;
    }
  }

  private async handleIncomingPost(data: any) {
    console.log("═".repeat(70));
    console.log("📨 KONFAM: NEW POST RECEIVED FROM X CLONE");
    console.log("═".repeat(70));
    console.log(`🆔 Post ID: ${data.post.id}`);
    console.log(`👤 Author: @${data.post.author.username}`);
    console.log(`📝 Content: "${data.post.content}"`);
    console.log(`🏷️  Language: ${data.post.language}`);
    console.log(`😊 Tone: ${data.post.emotionalTone}`);
    console.log(`🎯 Matched Rules:`);
    data.matchedRules.forEach((rule: any, i: number) => {
      console.log(`   ${i + 1}. ${rule.name}`);
      console.log(`      Keywords: [${rule.keywords.join(", ")}]`);
    });
    console.log(`⏰ Received at: ${data.timestamp}`);
    console.log("═".repeat(70));
    console.log("");

    // TODO: Store in Konfam database, trigger alerts, analytics, etc.
    // await this.storePost(data.post);
    // await this.triggerAlerts(data.matchedRules);
    // await this.updateAnalytics(data.post);
  }

  getConnectionStatus() {
    return this.isConnected;
  }
}

// Auto-start when imported
const consumer = new XCloneStreamConsumer();
consumer.connect().catch((err) => {
  console.error("Failed to start stream consumer:", err);
  process.exit(1);
});

export default consumer;

// // ============================================================================
// // FILE 7: consumer-example.ts
// // Example backend consumer (for testing)
// // Run this in a separate terminal to watch the stream
// // ============================================================================

// // consumer-example.ts

// const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";

// async function consumeStream() {
//   console.log("🔌 Connecting to filtered stream...\n");

//   const response = await fetch(`${BACKEND_URL}/filtered-stream`);

//   if (!response.ok) {
//     throw new Error(`HTTP error! status: ${response.status}`);
//   }

//   console.log("✅ Connected! Listening for posts...\n");

//   const reader = response.body?.getReader();
//   const decoder = new TextDecoder();

//   if (!reader) {
//     throw new Error("No response body");
//   }

//   while (true) {
//     const { done, value } = await reader.read();
    
//     if (done) {
//       console.log("Stream ended");
//       break;
//     }

//     const chunk = decoder.decode(value, { stream: true });
//     const lines = chunk.split("\n");
    
//     for (const line of lines) {
//       if (line.startsWith("data:")) {
//         const jsonStr = line.replace("data: ", "").trim();
//         if (!jsonStr) continue;
        
//         try {
//           const data = JSON.parse(jsonStr);
          
//           if (data.status === "connected") {
//             console.log("🎉 Stream connection established\n");
//           } else if (data.post) {
//             console.log("📨 NEW POST RECEIVED:");
//             console.log(`   Author: @${data.post.author.username}`);
//             console.log(`   Content: "${data.post.content}"`);
//             console.log(`   Matched Rules: ${data.matchedRules.map((r: any) => r.name).join(", ")}`);
//             console.log(`   Timestamp: ${data.timestamp}\n`);
//           }
//         } catch (err) {
//           console.error("Parse error:", err);
//         }
//       }
//     }
//   }
// }

// consumeStream().catch(console.error);
