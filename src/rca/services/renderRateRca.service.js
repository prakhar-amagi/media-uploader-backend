/* =========================================================
   Render-rate RCA orchestrator.

   channelId + UTC date + UTC hour
     -> resolve Athena cluster(s) from StormForge splits
        (same resolution the Impression RCA uses)
     -> 3 queries × N clusters, in parallel, failures isolated
     -> analyzers -> correlation -> verdict -> text report
   ========================================================= */

import { clusters } from "../clusters.js";
import { runAthenaQuery } from "./athenaClient.service.js";
import { resolveAthenaClusterKey } from "./athenaDetectionTrend.service.js";
import { getChannelSummary } from "../../services/trafficStormforge.service.js";

import {
  buildTimeWindow,
  buildRuleEngineErrorsQuery,
  buildUserDropQuery,
  buildTrackerErrorsQuery,
} from "../queries/renderRate.query.js";

import { RENDER_RCA_CONFIG as CFG } from "../rules/renderRate/config.js";
import { analyzeRuleEngine } from "../rules/renderRate/ruleEngineAnalyzer.js";
import { analyzeUserDrop } from "../rules/renderRate/userDropAnalyzer.js";
import { analyzeTracker } from "../rules/renderRate/trackerAnalyzer.js";
import { correlate, buildVerdict, buildTextReport } from "../rules/renderRate/verdict.js";

const CANCELLED_RE = /query\s+cancel+ed|state\s*CANCELLED|Athena query CANCELLED/i;

/** Run async jobs with at most `limit` in flight; keeps result order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const SSO_EXPIRED_RE = /token is expired|sso session|aws sso login|ExpiredToken|could not load credentials/i;

/**
 * Work out which Athena clusters to query.
 * Explicit clusterKeys win; otherwise resolve from StormForge.
 */
export async function resolveClustersForChannel(channelId, requestedKeys, { channelSummary = getChannelSummary } = {}) {
  if (requestedKeys?.length) {
    const unknown = requestedKeys.filter((k) => !clusters[k]);
    if (unknown.length) throw Object.assign(new Error(`Unknown cluster key(s): ${unknown.join(", ")}`), { status: 400 });
    return { source: "manual", clusterKeys: [...new Set(requestedKeys)], splits: [], deliveryName: null, unresolved: [] };
  }

  const summary = await channelSummary(channelId);
  const splits = summary.splits || [];
  const keys = [...new Set(splits.map((s) => resolveAthenaClusterKey(s.setup)).filter(Boolean))];

  return {
    source: "stormforge",
    clusterKeys: keys,
    splits,
    deliveryName: summary.deliveryName || null,
    unresolved: splits.map((s) => s.setup).filter((s) => !resolveAthenaClusterKey(s)),
  };
}

async function runOne({ name, clusterKey, sql, runQuery, limit }) {
  const config = clusters[clusterKey];
  const started = Date.now();
  let queryExecutionId = null;
  const diag = {
    query: name,
    clusterKey,
    region: config.region,
    database: config.database,
    outputLocation: config.outputLocation,
    profile: config.profile,
    workGroup: config.workGroup || process.env.ATHENA_WORKGROUP || "primary",
    startedAt: new Date(started).toISOString(),
    sql,
  };

  try {
    const rows = await runQuery({
      query: sql,
      region: config.region,
      database: config.database,
      outputLocation: config.outputLocation,
      profile: config.profile,
      workGroup: config.workGroup || process.env.ATHENA_WORKGROUP || undefined,
      onStarted: (id) => { queryExecutionId = id; },
    });
    for (const r of rows) r._cluster = clusterKey;
    return {
      ...diag,
      queryExecutionId,
      ok: true,
      rows,
      rowCount: rows.length,
      truncated: limit ? rows.length >= limit : false,
      durationMs: Date.now() - started,
      error: null,
      isSsoExpired: false,
      isCancelled: false,
    };
  } catch (error) {
    console.error(`Render-rate ${name} query failed on ${clusterKey}:`, error.message);
    const a = error.athena || {};
    return {
      ...diag,
      queryExecutionId: a.queryExecutionId || queryExecutionId,
      ok: false,
      rows: [],
      rowCount: 0,
      truncated: false,
      durationMs: Date.now() - started,
      error: error.message,
      isSsoExpired: SSO_EXPIRED_RE.test(error.message || ""),
      isCancelled: a.state === "CANCELLED" || CANCELLED_RE.test(error.message || ""),
      athena: error.athena || null,
    };
  }
}

function summarizeQuery(results) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return {
    ok: ok.length > 0,
    partial: ok.length > 0 && failed.length > 0,
    failedClusters: failed.map((r) => r.clusterKey),
    truncated: results.some((r) => r.truncated),
    error: failed[0]?.error || null,
    rows: ok.flatMap((r) => r.rows),
  };
}

function stripInternal(obj) {
  if (!obj) return obj;
  const { _byBreak, ...rest } = obj;
  return rest;
}

export async function runRenderRateRca(
  { channelId, date, hour, clusterKeys: requestedKeys },
  { runQuery = runAthenaQuery, channelSummary = getChannelSummary } = {}
) {
  const startedAt = Date.now();
  const { start, end } = buildTimeWindow(date, hour);

  const resolution = await resolveClustersForChannel(channelId, requestedKeys, { channelSummary });
  if (!resolution.clusterKeys.length) {
    throw Object.assign(
      new Error(
        `No Athena-queryable cluster for this channel (setups: ${resolution.unresolved.join(", ") || "none"}). ` +
          "Pick a cluster manually."
      ),
      { status: 422 }
    );
  }

  const limit = CFG.errorQueryLimit;

  const jobs = resolution.clusterKeys.flatMap((clusterKey) => {
    const { database } = clusters[clusterKey];
    const base = { database, channelId, start, end };
    return [
      { name: "ruleEngine", clusterKey, limit, sql: buildRuleEngineErrorsQuery({ ...base, limit }) },
      {
        name: "userDrop",
        clusterKey,
        limit: null,
        sql: buildUserDropQuery({
          ...base,
          lookbackMinutes: CFG.activeUsersLookbackMin,
          lookaheadMinutes: CFG.activeUsersLookaheadMin,
        }),
      },
      { name: "tracker", clusterKey, limit, sql: buildTrackerErrorsQuery({ ...base, limit }) },
    ];
  });

  // Raw log tables are large; firing 3×N scans at once is the most likely
  // thing to trip an account-level Athena guard. Run a few at a time.
  const results = await mapWithConcurrency(jobs, CFG.maxConcurrentQueries, (j) => runOne({ ...j, runQuery }));
  const by = (name) => summarizeQuery(results.filter((r) => r.query === name));

  const q = { ruleEngine: by("ruleEngine"), userDrop: by("userDrop"), tracker: by("tracker") };

  const ruleEngine = analyzeRuleEngine(q.ruleEngine.rows);
  const userDrop = analyzeUserDrop(q.userDrop.rows);
  const tracker = analyzeTracker(q.tracker.rows);

  const queryStatus = Object.fromEntries(
    Object.entries(q).map(([k, v]) => [k, { ok: v.ok, partial: v.partial, failedClusters: v.failedClusters, truncated: v.truncated, error: v.error }])
  );

  const correlation = correlate({
    ruleEngine,
    userDrop: queryStatus.userDrop.ok ? userDrop : null,
    tracker,
  });
  const verdict = buildVerdict({ ruleEngine, userDrop, tracker, queryStatus });

  const cancelled = results.filter((r) => r.isCancelled);
  if (cancelled.length) {
    verdict.caveats.unshift(
      `${cancelled.length} of ${results.length} Athena queries were CANCELLED by an external StopQueryExecution call ` +
        "(this app never cancels queries). On this account that is usually athena-query-validator rejecting " +
        "data older than its age limit; check RENDER_RCA_MAX_DATA_AGE_DAYS or its CloudWatch logs."
    );
  }

  const input = {
    channelId,
    date,
    hour: Number(hour),
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    clusters: resolution.clusterKeys,
  };

  const report = buildTextReport({ input, verdict, ruleEngine, userDrop, tracker, correlation });

  return {
    input,
    clusterResolution: resolution,
    verdict,
    ruleEngine: stripInternal(ruleEngine),
    userDrop: {
      ...userDrop,
      // keep the response light; the full list is only needed for small hours
      breaks: userDrop.breaks.slice(0, 500),
      allAdBreakIds: undefined,
    },
    tracker: stripInternal(tracker),
    correlation,
    queryStatus,
    diagnostics: results.map(({ rows, ...d }) => d),
    report,
    elapsedMs: Date.now() - startedAt,
  };
}
