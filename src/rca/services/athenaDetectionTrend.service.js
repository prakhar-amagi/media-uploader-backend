import { clusters } from "../clusters.js";
import { runAthenaQuery } from "./athenaClient.service.js";
import { buildAdAnalyticsQuery } from "../queries/adAnalytics.query.js";
import { SETUP_TO_CLUSTER } from "../../services/grafana.service.js";

const NUMERIC_FIELDS = [
  "detections", "duration", "requests", "empty", "errors",
  "total_ads", "non_transcoded", "overflow", "repeated",
  "usable_ads", "impressions", "q25", "q50", "q75", "q100", "conversion",
];

function coerceRow(row) {
  const out = { ts: row.ts };
  for (const field of NUMERIC_FIELDS) {
    const raw = row[field];
    out[field] = raw === null || raw === undefined ? 0 : Number(raw);
  }
  return out;
}

/**
 * Resolve a StormForge cluster_split "setup" value (e.g. "ts-us-e2-n1")
 * to an Athena-queryable cluster key, reusing the same SETUP_TO_CLUSTER
 * map the traffic analyzer already relies on — so a channel's cluster
 * splits resolve identically for both Grafana and Athena.
 */
export function resolveAthenaClusterKey(setupName) {
  const clusterKey = SETUP_TO_CLUSTER[setupName];
  if (!clusterKey) return null;
  return clusters[clusterKey] ? clusterKey : null; // only "known to Athena" if clusters.js has it
}

export async function getDetectionTrend({ channelId, clusterKey, days = 15 }) {
  const config = clusters[clusterKey];
  if (!config) throw new Error(`Unknown Athena cluster: ${clusterKey}`);

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const format = (d) => d.toISOString().slice(0, 19).replace("T", " ");

  const query = buildAdAnalyticsQuery({
    database: config.database,
    channelId,
    startDate: format(start),
    endDate: format(end),
  });

  const rows = await runAthenaQuery({
    query,
    region: config.region,
    database: config.database,
    outputLocation: config.outputLocation,
    profile: config.profile,
  });

  return rows.map(coerceRow);
}

/**
 * Run the detection trend across every cluster a channel is split
 * across, summing same-day rows together into one merged series.
 *
 * Each perCluster entry carries connection diagnostics (region,
 * database, outputLocation, profile) alongside ok/error, so the UI
 * can show exactly what was attempted and what failed — not just a
 * generic error string.
 */
export async function getDetectionTrendAcrossClusters({ channelId, clusterKeys, days = 15 }) {
  const perCluster = await Promise.all(
    clusterKeys.map(async (clusterKey) => {
      const config = clusters[clusterKey];

      const diagnostics = {
        clusterKey,
        region: config?.region || null,
        database: config?.database || null,
        outputLocation: config?.outputLocation || null,
        profile: config?.profile || null,
      };

      try {
        const rows = await getDetectionTrend({ channelId, clusterKey, days });
        return { ...diagnostics, ok: true, rows, rowCount: rows.length, error: null, isSsoExpired: false };
      } catch (error) {
        console.error(`Athena detection trend failed for cluster ${clusterKey}:`, error.message);

        const isSsoExpired = /token is expired|sso session|aws sso login/i.test(error.message || "");

        return {
          ...diagnostics,
          ok: false,
          rows: [],
          rowCount: 0,
          error: error.message,
          isSsoExpired,
        };
      }
    })
  );

  const merged = {};

  for (const { rows } of perCluster) {
    for (const row of rows) {
      if (!merged[row.ts]) {
        merged[row.ts] = { ts: row.ts };
        for (const field of NUMERIC_FIELDS) merged[row.ts][field] = 0;
      }
      for (const field of NUMERIC_FIELDS) {
        if (field === "conversion") continue;
        merged[row.ts][field] += row[field] ?? 0;
      }
    }
  }

  for (const day of Object.values(merged)) {
    day.conversion = day.usable_ads
      ? Number(((day.impressions / day.usable_ads) * 100).toFixed(2))
      : 0;
  }

  const mergedRows = Object.values(merged).sort((a, b) => a.ts.localeCompare(b.ts));

  return { perCluster, merged: mergedRows };
}
