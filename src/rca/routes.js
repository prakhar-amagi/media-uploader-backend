import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";

import {
  getSpringServeTopology,
  buildNormalizedTopology,
  groupDemandTagsByPriorityTier,
} from "./services/springserveTopology.service.js";

import {
  getDemandTagPerformance,
} from "./services/springserve.service.js";

import {
  getChannelSummary,
} from "../services/trafficStormforge.service.js";

import {
  getDetectionTrendAcrossClusters,
  resolveAthenaClusterKey,
} from "./services/athenaDetectionTrend.service.js";

import {
  getAcuTrend,
} from "./services/acuTrend.service.js";

import {
  analyzeFullRca,
  summarizeAthenaTrend,
  summarizeAcuTrend,
  normalizeSpringservePerformance,
  summarizeSpringservePerformance,
} from "./rules/fullAnalysis.js";

import { analyzeDemandTagPerformance } from "./rules/demandTagRules.js";

/**
 * SpringServe's /dashboards/tag_performance ignores date_range and
 * always returns ~30 days of data regardless of what's requested
 * (confirmed by testing the real API directly with different
 * date_range values — it made no difference). Rather than trust
 * the API's filtering, we always fetch what it gives us and trim
 * to the actually-requested window ourselves.
 */
function trimToLastNDays(dailyRows, days) {
  const n = Number(days);
  if (!n || n <= 0 || n >= dailyRows.length) return dailyRows;
  return dailyRows.slice(-n);
}

import RcaInvestigation from "./models/RcaInvestigation.js";

import {
  startDeviceAuthorization,
  pollDeviceAuthorization,
  checkAwsConnection,
} from "./services/awsSso.service.js";

const router = express.Router();
router.use(requireAuth);

/* =========================================================
   Extract the SpringServe supply router ID from a StormForge
   delivery config's ad tag URL, e.g.
   https://tv.adserve.amagi.com/rt/85839?... -> "85839"
   ========================================================= */
function extractSupplyRouterId(stormforgeData) {
  const configurations =
    stormforgeData?.ssai_configuration?.ad_decision_configuration || [];

  for (const config of configurations) {
    for (const adTag of config?.ad_tags || []) {
      const match = (adTag?.url || "").match(/\/rt\/(\d+)/);
      if (match) return match[1];
    }
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   GET /rca/topology?channelId=xxx  (or ?supplyRouterId=xxx)
   Resolves the SpringServe supply router topology for a channel,
   including a ready-made priority/tier grouping for demand-tag
   selection.
═══════════════════════════════════════════════════════════════════════ */
router.get("/topology", async (req, res) => {
  try {
    const { channelId, supplyRouterId: supplyRouterIdParam } = req.query;
    let supplyRouterId = supplyRouterIdParam;
    let deliveryConfig = null;

    if (!supplyRouterId && channelId) {
      const summary = await getChannelSummary(channelId);
      deliveryConfig = summary;

      // getChannelSummary doesn't expose the raw ssai_configuration,
      // so pull the raw config only if we need to extract the router id.
      const { getDeliveryConfig } = await import("../services/trafficStormforge.service.js");
      const raw = await getDeliveryConfig(channelId);
      supplyRouterId = extractSupplyRouterId(raw);

      if (!supplyRouterId) {
        return res.status(404).json({
          error: "Could not find SpringServe supply router ID in StormForge configuration",
          channelId,
        });
      }
    }

    if (!supplyRouterId) {
      return res.status(400).json({ error: "channelId or supplyRouterId is required" });
    }

    const topology = await getSpringServeTopology(supplyRouterId, { channelId });
    const normalizedTopology = buildNormalizedTopology({ ...topology, channelId: channelId || null });

    return res.json({
      channelId: channelId || null,
      supplyRouterId: String(supplyRouterId),
      deliverySummary: deliveryConfig,
      springserve: topology,
      normalized: normalizedTopology,
      prioritySelection: groupDemandTagsByPriorityTier(normalizedTopology),
    });
  } catch (error) {
    console.error("RCA topology error:", error);
    return res.status(500).json({
      error: "Failed to retrieve RCA topology",
      detail: error.response?.data || error.message || "Unknown error",
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   GET /rca/demand-tag/:demandTagId?days=15&interval=day
   Day-wise SpringServe tag performance for a single demand tag.

   Note: SpringServe's date_range param is unreliable (confirmed by
   testing the real API directly — it made no difference), so this
   always fetches the full ~30-day window and trims to `days` here.
═══════════════════════════════════════════════════════════════════════ */
router.get("/demand-tag/:demandTagId", async (req, res) => {
  try {
    const { demandTagId } = req.params;
    const { days = 30, interval = "day" } = req.query;

    const raw = await getDemandTagPerformance(demandTagId, { dateRange: "Last 30 Days", interval, tagType: "demand" });
    const fullDaily = normalizeSpringservePerformance(raw, interval);
    const daily = trimToLastNDays(fullDaily, days);
    const summary = summarizeSpringservePerformance(daily);
    const rca = analyzeDemandTagPerformance(summary);

    return res.json({ demandTagId: Number(demandTagId), days: Number(days), interval, daily, summary, rca });
  } catch (error) {
    console.error("Demand tag analysis error:", error);
    return res.status(500).json({ error: "Failed to retrieve demand tag data", detail: error.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   GET /rca/investigate?channelId=xxx&demandTagId=xxx&days=15
   Single call: ACU -> Athena funnel -> SpringServe demand, combined
   into one RCA verdict. Persists the result to Mongo.
═══════════════════════════════════════════════════════════════════════ */
router.get("/investigate", async (req, res) => {
  try {
    const { channelId, demandTagId, days = 15 } = req.query;

    if (!channelId) return res.status(400).json({ error: "channelId is required" });
    if (!demandTagId) return res.status(400).json({ error: "demandTagId is required" });

    /* 1. StormForge -> cluster splits (setup values, e.g. "ts-us-e2-n1") */
    const summary = await getChannelSummary(channelId);
    if (!summary.splits.length) {
      return res.status(422).json({ error: "No cluster split found in delivery config" });
    }

    const setups = summary.splits.map((s) => s.setup);

    /* 2. Resolve Athena-queryable cluster keys from those setups */
    const resolvedClusterKeys = [...new Set(setups.map(resolveAthenaClusterKey).filter(Boolean))];
    const unresolvedSetups = setups.filter((s) => !resolveAthenaClusterKey(s));

    /* 3. ACU (users) trend */
    const acuTrend = await getAcuTrend({ channelId, setups, days: Number(days) });
    const acuSummary = summarizeAcuTrend(acuTrend.merged);

    /* 4. Athena ad-marker/funnel trend */
    let athenaTrend = { perCluster: [], merged: [] };
    if (resolvedClusterKeys.length > 0) {
      athenaTrend = await getDetectionTrendAcrossClusters({
        channelId, clusterKeys: resolvedClusterKeys, days: Number(days),
      });
    }
    const athenaSummary = summarizeAthenaTrend(athenaTrend.merged);

    /* 5. SpringServe demand-tag day-wise performance.
       The API ignores date_range and always returns ~30 days
       regardless of what we ask for, so we always request the
       full window and trim to `days` ourselves below. */
    const springserveRaw = await getDemandTagPerformance(demandTagId, {
      dateRange: "Last 30 Days", interval: "day", tagType: "demand",
    });
    const springserveDailyFull = normalizeSpringservePerformance(springserveRaw, "day");
    const springserveDaily = trimToLastNDays(springserveDailyFull, days);
    const springserveSummary = summarizeSpringservePerformance(springserveDaily);

    /* 6. Combined verdict */
    const rca = analyzeFullRca({
      athenaSummary,
      acuSummary,
      springserveSummary,
    });

    /* 7. Persist */
    const doc = await RcaInvestigation.create({
      channelId,
      deliveryName: summary.deliveryName,
      demandTagId: Number(demandTagId),
      daysAnalyzed: Number(days),
      status: rca.status,
      confidence: rca.confidence,
      reason: rca.reason,
      evidence: rca.evidence,
      queriedBy: req.user.email,
    });

    return res.json({
      channelId,
      deliveryName: summary.deliveryName,
      demandTagId: Number(demandTagId),

      clusters: {
        setups,
        resolved: resolvedClusterKeys,
        unresolved: unresolvedSetups,
      },

      acu: { ...acuSummary, perSetup: acuTrend.perSetup },
      athena: { summary: athenaSummary, perCluster: athenaTrend.perCluster },
      springserve: { daily: springserveDaily, summary: springserveSummary },

      rca,
      investigationId: doc._id,
    });
  } catch (error) {
    console.error("RCA investigate error:", error);
    return res.status(500).json({
      error: "Failed to run RCA investigation",
      detail: error.response?.data || error.message || "Unknown error",
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   GET /rca/history?channelId=xxx&limit=20
═══════════════════════════════════════════════════════════════════════ */
router.get("/history", async (req, res) => {
  const { channelId, limit = 20 } = req.query;
  const filter = channelId ? { channelId } : {};
  const docs = await RcaInvestigation.find(filter)
    .sort({ createdAt: -1 })
    .limit(parseInt(limit));
  res.json(docs);
});

/* ═══════════════════════════════════════════════════════════════════════
   AWS SSO connection — mandatory gate before running an investigation.

   GET  /rca/aws-sso/status?profile=thunderstorm-v3
     Check if Athena credentials currently resolve.

   POST /rca/aws-sso/connect
     Start the device-authorization flow (same as `aws sso login`).
     Returns a verification URL to open + a session id to poll.

   GET  /rca/aws-sso/poll?sessionId=xxx
     Poll for completion. Once done, credentials are cached on disk
     the same way the AWS CLI does, so Athena calls work immediately.
═══════════════════════════════════════════════════════════════════════ */

const DEFAULT_AWS_PROFILE = "thunderstorm-v3";

router.get("/aws-sso/status", async (req, res) => {
  try {
    const profile = req.query.profile || DEFAULT_AWS_PROFILE;
    const status = await checkAwsConnection(profile);
    return res.json({ profile, ...status });
  } catch (error) {
    return res.status(500).json({ connected: false, error: error.message });
  }
});

router.post("/aws-sso/connect", async (req, res) => {
  try {
    const profile = req.body?.profile || DEFAULT_AWS_PROFILE;
    const result = await startDeviceAuthorization(profile);
    return res.json(result);
  } catch (error) {
    console.error("SSO device authorization start failed:", error);
    return res.status(500).json({ error: error.message });
  }
});

router.get("/aws-sso/poll", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const result = await pollDeviceAuthorization(sessionId);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

export default router;
