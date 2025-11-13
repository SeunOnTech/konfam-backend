/**
 * dashboard.controller.ts — Unified Dashboard API
 * ------------------------------------------------------------
 * Routes:
 *  GET  /api/dashboard/threats           → Threat list
 *  GET  /api/dashboard/metrics           → Key metrics summary
 *  GET  /api/dashboard/sentiment         → Average sentiment
 *  GET  /api/dashboard/trending          → Trending topics
 *  PATCH /api/dashboard/threats/:id/address → Mark threat addressed
 *  POST /api/dashboard/responses/deploy  → Deploy AI response
 * ------------------------------------------------------------
 */

import { PrismaClient, ThreatStatus } from "@prisma/client"
import express from "express"

export const dashboardRouter = express.Router()
const prisma = new PrismaClient()

/* ------------------------------------------------------------
 * 🧩 Helper — Time Range Handler
 * ------------------------------------------------------------ */
function getTimeFilter(range?: string) {
  const now = new Date()
  const start =
    range === "week"
      ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      : new Date(now.setHours(0, 0, 0, 0)) // today default
  return start
}

/* ------------------------------------------------------------
 * 1️⃣ Get Threats (filtered by time range)
 * ------------------------------------------------------------ */
dashboardRouter.get("/threats", async (req, res) => {
  try {
    const { timeRange } = req.query
    const from = getTimeFilter(timeRange as string)

    const threats = await prisma.threat.findMany({
      where: {
        detectedAt: { gte: from },
      },
      include: {
        detectedPost: true,
        brand: true,
        response: true,
      },
      orderBy: { detectedAt: "desc" },
    })

    const postsAnalyzed = await prisma.detectedPost.count({
      where: { capturedAt: { gte: from } },
    })

    const activeThreats = threats.filter(
      (t) => t.status !== ThreatStatus.RESOLVED
    ).length

    res.json({
      success: true,
      data: { threats, activeThreats, postsAnalyzed },
    })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

/* ------------------------------------------------------------
 * 2️⃣ Dashboard Metrics Overview
 * ------------------------------------------------------------ */
dashboardRouter.get("/metrics", async (req, res) => {
  try {
    const { timeRange } = req.query
    const from = getTimeFilter(timeRange as string)

    const [postsAnalyzed, activeThreats, responses, sentiment] =
      await Promise.all([
        prisma.detectedPost.count({
          where: { capturedAt: { gte: from } },
        }),
        prisma.threat.count({
          where: {
            detectedAt: { gte: from },
            status: { not: ThreatStatus.RESOLVED },
          },
        }),
        prisma.response.count({
          where: { status: "POSTED" },
        }),
        prisma.detectedPost.aggregate({
          _avg: { sentimentPolarity: true },
          where: { capturedAt: { gte: from } },
        }),
      ])

    res.json({
      success: true,
      data: {
        postsAnalyzed,
        activeThreats,
        responsesDeployed: responses,
        avgSentiment: sentiment._avg.sentimentPolarity ?? 0,
      },
    })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

/* ------------------------------------------------------------
 * 3️⃣ Average Sentiment Gauge
 * ------------------------------------------------------------ */
dashboardRouter.get("/sentiment", async (req, res) => {
  try {
    const { timeRange } = req.query
    const from = getTimeFilter(timeRange as string)

    const result = await prisma.detectedPost.aggregate({
      _avg: { sentimentPolarity: true },
      where: { capturedAt: { gte: from } },
    })

    res.json({
      success: true,
      data: { averageSentiment: result._avg.sentimentPolarity ?? 0 },
    })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

/* ------------------------------------------------------------
 * 4️⃣ Trending Topics / Hashtags
 * ------------------------------------------------------------ */
dashboardRouter.get("/trending", async (req, res) => {
  try {
    const { timeRange, limit = 10 } = req.query
    const from = getTimeFilter(timeRange as string)

    const posts = await prisma.detectedPost.findMany({
      where: { capturedAt: { gte: from } },
      select: { matchedKeywords: true },
    })

    // Flatten all matched keywords
    const keywordCounts: Record<string, number> = {}
    for (const p of posts) {
      for (const kw of p.matchedKeywords || []) {
        const key = kw.trim().toLowerCase()
        if (!key) continue
        keywordCounts[key] = (keywordCounts[key] || 0) + 1
      }
    }

    // Sort & limit
    const trending = Object.entries(keywordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Number(limit))
      .map(([keyword, count]) => ({ keyword, count }))

    res.json({ success: true, data: trending })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

/* ------------------------------------------------------------
 * 5️⃣ Mark Threat as Addressed
 * ------------------------------------------------------------ */
dashboardRouter.patch("/threats/:id/address", async (req, res) => {
  try {
    const { id } = req.params
    const { responsePostId } = req.body

    const threat = await prisma.threat.update({
      where: { id },
      data: {
        status: ThreatStatus.RESPONDED,
        resolvedAt: new Date(),
        response: {
          upsert: {
            create: {
              platform: "TWITTER",
              content: `Response posted at ${new Date().toISOString()}`,
              sourcesUsed: [],
              confidence: 0.9,
              status: "POSTED",
              postedAt: new Date(),
            },
            update: {
              status: "POSTED",
              postedAt: new Date(),
            },
          },
        },
      },
      include: { response: true },
    })

    res.json({ success: true, data: threat })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

/* ------------------------------------------------------------
 * 6️⃣ Deploy AI Response (manual trigger)
 * ------------------------------------------------------------ */
dashboardRouter.post("/responses/deploy", async (req, res) => {
  try {
    const { threatId, text, platform = "TWITTER" } = req.body
    const response = await prisma.response.create({
      data: {
        threatId,
        platform,
        content: text,
        sourcesUsed: [],
        confidence: 0.95,
        status: "POSTED",
        postedAt: new Date(),
      },
    })
    res.json({ success: true, data: response })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})
