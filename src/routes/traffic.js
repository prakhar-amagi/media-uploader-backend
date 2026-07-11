import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { queryRange, verifyToken, CLUSTERS, SETUP_TO_CLUSTER, getToken } from "../services/grafana.service.js";
import { getChannelSummary } from "../services/trafficStormforge.service.js";
import TrafficQuery from "../models/TrafficQuery.js";

const router = express.Router();
router.use(requireAuth);

/* ─── PromQL templates ─────────────────────────────────────────────────────── */
const acuQuery = (channelId) => `max_over_time(
  prefetcher_user_count{
    channel_id=~"${channelId}",
    namespace=~"default",
    type="active"
  }[1m]
)`;

const impressionsQuery = (channelId) => `sum by(metric)(
  increase(
    tracker_counter{
      id=~"${channelId}",
      namespace=~"default",
      metric!="incomingMsg",
      break_type=~"MID_ROLL"
    }[1m]
  )
)`;

/* ─── Flatten helpers ──────────────────────────────────────────────────────── */
function flattenMax(result) {
  // MAX across series per timestamp — correct for concurrent-user gauges
  const merged = {};
  for (const series of result) {
    for (const [ts, val] of series.values || []) {
      const t = parseInt(ts);
      const v = parseFloat(val);
      if (merged[t] === undefined || v > merged[t]) merged[t] = v;
    }
  }
  return Object.entries(merged).sort((a, b) => a[0] - b[0]).map(([t, v]) => [parseInt(t), v]);
}

function flattenSum(result, metricFilter = null) {
  // SUM across series — with optional filter on 'metric' label
  const merged = {};
  for (const series of result) {
    if (metricFilter && series.metric?.metric !== metricFilter) continue;
    for (const [ts, val] of series.values || []) {
      const t = parseInt(ts);
      merged[t] = (merged[t] || 0) + parseFloat(val);
    }
  }
  return Object.entries(merged).sort((a, b) => a[0] - b[0]).map(([t, v]) => [parseInt(t), v]);
}

/* ─── Aggregation helpers ──────────────────────────────────────────────────── */
function dayKey(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function groupByDay(points) {
  const days = {};
  for (const [ts, val] of points) {
    const d = dayKey(ts);
    if (!days[d]) days[d] = [];
    days[d].push(val);
  }
  return days;
}

function summarizeSetup(acuPoints, imprPoints) {
  const acuByDay   = groupByDay(acuPoints);
  const imprByDay  = groupByDay(imprPoints);

  const allDays = new Set([...Object.keys(acuByDay), ...Object.keys(imprByDay)]);

  const dailyBreakdown = [];
  for (const date of [...allDays].sort()) {
    const acuVals  = acuByDay[date]  || [];
    const imprVals = imprByDay[date] || [];
    dailyBreakdown.push({
      date,
      acu:         acuVals.length  ? acuVals.reduce((s, v) => s + v, 0) / acuVals.length : 0,
      impressions: imprVals.reduce((s, v) => s + v, 0),
    });
  }

  const avgAcuPerDay         = dailyBreakdown.length
    ? dailyBreakdown.reduce((s, d) => s + d.acu, 0) / dailyBreakdown.length
    : 0;
  const avgImpressionsPerDay = dailyBreakdown.length
    ? dailyBreakdown.reduce((s, d) => s + d.impressions, 0) / dailyBreakdown.length
    : 0;

  return {
    avgAcuPerDay:         Math.round(avgAcuPerDay * 100) / 100,
    avgImpressionsPerDay: Math.round(avgImpressionsPerDay * 100) / 100,
    dailyBreakdown,
    daysAnalyzed: dailyBreakdown.length,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   GET /traffic/token-status
   Shows which Grafana clusters have tokens configured and reachable.
═══════════════════════════════════════════════════════════════════════════ */
router.get("/token-status", async (req, res) => {
  const results = await Promise.all(
    Object.entries(CLUSTERS).map(async ([clusterKey, host]) => {
      const configured = !!getToken(clusterKey);
      if (!configured) {
        return { cluster: clusterKey, host, configured: false, reachable: null, error: "Token not set in .env" };
      }
      const check = await verifyToken(clusterKey);
      return { cluster: clusterKey, host, configured: true, reachable: check.ok, error: check.error || null, org: check.org || null };
    })
  );
  res.json(results);
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /traffic/setup-split?channelId=xxx&days=7
   Main endpoint: fetch ACU + impressions per setup from Grafana.
═══════════════════════════════════════════════════════════════════════════ */
router.get("/setup-split", async (req, res) => {
  const { channelId, days: daysStr = "7" } = req.query;
  const days = Math.min(Math.max(parseInt(daysStr) || 7, 1), 30);

  if (!channelId) return res.status(400).json({ error: "channelId is required" });

  let summary;
  try {
    summary = await getChannelSummary(channelId);
  } catch (err) {
    const status = err.response?.status === 404 ? 404 : 502;
    return res.status(status).json({ error: `StormForge error: ${err.message}` });
  }

  if (!summary.splits.length) {
    return res.status(422).json({ error: "No cluster split found in delivery config" });
  }

  const results = [];
  const errors  = [];

  for (const split of summary.splits) {
    const { setup, splitPct, product } = split;

    try {
      const [acuResult, imprResult] = await Promise.all([
        queryRange({ setup, promql: acuQuery(channelId), days }),
        queryRange({ setup, promql: impressionsQuery(channelId), days }),
      ]);

      const acuPoints  = flattenMax(acuResult);
      const imprPoints = flattenSum(imprResult, "Impression");
      const setupSummary = summarizeSetup(acuPoints, imprPoints);

      // Persist to MongoDB
      const doc = await TrafficQuery.create({
        channelId,
        deliveryName:         summary.deliveryName,
        setup,
        trafficSplitPct:      splitPct,
        avgAcuPerDay:         setupSummary.avgAcuPerDay,
        avgImpressionsPerDay: setupSummary.avgImpressionsPerDay,
        daysAnalyzed:         setupSummary.daysAnalyzed,
        dailyBreakdown:       setupSummary.dailyBreakdown,
        queriedBy:            req.user.email,
      });

      results.push({
        setup,
        product,
        splitPct,
        avgAcuPerDay:         setupSummary.avgAcuPerDay,
        avgImpressionsPerDay: setupSummary.avgImpressionsPerDay,
        daysAnalyzed:         setupSummary.daysAnalyzed,
        queryId:              doc._id,
      });

    } catch (err) {
      const isTokenErr = err.message.includes("No Grafana token");
      errors.push({
        setup,
        error:  isTokenErr ? "token_missing" : "query_failed",
        detail: err.message,
      });
    }
  }

  if (!results.length && errors.length) {
    return res.status(503).json({ errors });
  }

  res.json({
    channelId,
    deliveryName:               summary.deliveryName,
    customerName:               summary.customerName,
    setups:                     results,
    totalAvgAcuPerDay:          Math.round(results.reduce((s, r) => s + r.avgAcuPerDay, 0) * 100) / 100,
    totalAvgImpressionsPerDay:  Math.round(results.reduce((s, r) => s + r.avgImpressionsPerDay, 0) * 100) / 100,
    errors:                     errors.length ? errors : undefined,
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /traffic/trend/:queryId
   Returns the daily breakdown for a specific query result.
═══════════════════════════════════════════════════════════════════════════ */
router.get("/trend/:queryId", async (req, res) => {
  const doc = await TrafficQuery.findById(req.params.queryId).select("dailyBreakdown setup");
  if (!doc) return res.status(404).json({ error: "Query not found" });
  res.json({ setup: doc.setup, trend: doc.dailyBreakdown });
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /traffic/history?channelId=xxx&limit=20
   Recent queries from MongoDB.
═══════════════════════════════════════════════════════════════════════════ */
router.get("/history", async (req, res) => {
  const { channelId, limit = 20 } = req.query;
  const filter = channelId ? { channelId } : {};
  const docs = await TrafficQuery.find(filter)
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .select("-dailyBreakdown");
  res.json(docs);
});

export default router;
