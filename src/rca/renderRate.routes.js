import express from "express";

import RenderRateInvestigation from "./models/RenderRateInvestigation.js";
import { runRenderRateRca } from "./services/renderRateRca.service.js";
import { clusters } from "./clusters.js";
import { RENDER_RCA_CONFIG as CFG } from "./rules/renderRate/config.js";
import { dataAgeDays, oldestAllowedDate } from "./queries/renderRate.query.js";

/* Mounted under /rca/render-rate by src/rca/routes.js, so it
   inherits requireAuth from the parent RCA router. */
const router = express.Router();

const CHANNEL_ID_RE = /^[A-Za-z0-9._:-]{3,200}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate({ channelId, date, hour, clusterKeys }) {
  if (!channelId || !CHANNEL_ID_RE.test(channelId)) return "channelId is required (letters, digits, . _ : -)";
  if (!date || !DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return "date must be YYYY-MM-DD (UTC)";

  const h = Number(hour);
  if (hour === undefined || hour === "" || !Number.isInteger(h) || h < 0 || h > 23) return "hour must be an integer 0-23 (UTC)";

  const start = Date.parse(`${date}T${String(h).padStart(2, "0")}:00:00Z`);
  if (start > Date.now()) return "The selected hour is in the future";

  if (CFG.maxDataAgeDays > 0) {
    const age = dataAgeDays({ date, hour: h, lookbackMinutes: CFG.activeUsersLookbackMin });
    if (age > CFG.maxDataAgeDays) {
      return (
        `${date} ${String(h).padStart(2, "0")}:00 UTC is ${age} days old. Athena queries on raw logs older than ` +
        `${CFG.maxDataAgeDays} days are cancelled by the account's athena-query-validator. ` +
        `Pick an hour on or after ${oldestAllowedDate(CFG.maxDataAgeDays)}.`
      );
    }
  }

  if (clusterKeys !== undefined && !Array.isArray(clusterKeys)) return "clusterKeys must be an array";
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   GET /rca/render-rate/limits — lets the UI restrict the date picker
═══════════════════════════════════════════════════════════════════════ */
router.get("/limits", (_req, res) => {
  res.json({
    maxDataAgeDays: CFG.maxDataAgeDays,
    oldestAllowedDate: CFG.maxDataAgeDays > 0 ? oldestAllowedDate(CFG.maxDataAgeDays) : null,
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   GET /rca/render-rate/clusters — cluster keys for the manual override
═══════════════════════════════════════════════════════════════════════ */
router.get("/clusters", (_req, res) => {
  res.json(Object.entries(clusters).map(([key, c]) => ({ key, region: c.region, database: c.database })));
});

/* ═══════════════════════════════════════════════════════════════════════
   POST /rca/render-rate/analyze
   body: { channelId, date: "YYYY-MM-DD", hour: 0-23, clusterKeys?: [] }
═══════════════════════════════════════════════════════════════════════ */
router.post("/analyze", async (req, res) => {
  const body = req.body || {};
  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : body.channelId;
  const clusterKeys = Array.isArray(body.clusterKeys) && body.clusterKeys.length ? body.clusterKeys : undefined;

  const invalid = validate({ channelId, date: body.date, hour: body.hour, clusterKeys });
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const result = await runRenderRateRca({
      channelId,
      date: body.date,
      hour: Number(body.hour),
      clusterKeys,
    });

    // Persist the verdict; don't fail the response if Mongo is unhappy.
    try {
      const doc = await RenderRateInvestigation.create({
        channelId,
        deliveryName: result.clusterResolution.deliveryName,
        date: body.date,
        hour: Number(body.hour),
        clusters: result.input.clusters,
        status: result.verdict.status,
        confidence: result.verdict.confidence,
        headline: result.verdict.headline,
        reason: result.verdict.reason,
        primaryFactor: result.verdict.primaryFactor,
        factors: result.verdict.factors,
        metrics: {
          transcodeFailures: result.ruleEngine.transcodeFailures,
          uniqueFailedAssets: result.ruleEngine.uniqueAssets,
          adBreaks: result.userDrop.breaksAnalyzed,
          significantDropBreaks: result.userDrop.significantDropBreaks,
          weightedDropPct: result.userDrop.weightedDropPct,
          trackerErrors: result.tracker.totalErrors,
          correlatedBreaks: result.correlation.correlatedBreaks,
        },
        report: result.report,
        queriedBy: req.user?.email,
      });
      result.investigationId = doc._id;
    } catch (persistError) {
      console.error("Render-rate RCA persist failed:", persistError.message);
    }

    return res.json(result);
  } catch (error) {
    console.error("Render-rate RCA error:", error);
    return res.status(error.status || 500).json({
      error: "Failed to run render-rate RCA",
      detail: error.response?.data || error.message || "Unknown error",
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   GET /rca/render-rate/history?channelId=xxx&limit=20
   GET /rca/render-rate/history/:id   (full saved report)
═══════════════════════════════════════════════════════════════════════ */
router.get("/history", async (req, res) => {
  try {
    const { channelId } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const filter = channelId ? { channelId } : {};
    const docs = await RenderRateInvestigation.find(filter)
      .select("-report -factors")
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json(docs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/history/:id", async (req, res) => {
  try {
    const doc = await RenderRateInvestigation.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
