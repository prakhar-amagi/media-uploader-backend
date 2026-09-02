import { queryRange, SETUP_TO_CLUSTER } from "../../services/grafana.service.js";

// Same PromQL template as routes/traffic.js's acuQuery — kept in sync
// deliberately rather than importing from a route file.
const acuQuery = (channelId) => `max_over_time(
  prefetcher_user_count{
    channel_id=~"${channelId}",
    namespace=~"default",
    type="active"
  }[1m]
)`;

function flattenMax(result) {
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

/**
 * ACU (concurrent user) daily trend for a channel across the setups
 * it's split over, using the same "setup" values StormForge returns
 * (e.g. "ts-us-e2-n1") — same input shape trafficStormforge.service.js
 * already produces.
 */
export async function getAcuTrend({ channelId, setups, days = 15 }) {
  const perSetup = await Promise.all(
    setups
      .filter((setup) => SETUP_TO_CLUSTER[setup]) // only query setups Grafana knows about
      .map(async (setup) => {
        const clusterKey = SETUP_TO_CLUSTER[setup];

        try {
          const result = await queryRange({ setup, promql: acuQuery(channelId), days });
          const points = flattenMax(result);
          const byDay = groupByDay(points);

          const daily = Object.entries(byDay)
            .map(([date, vals]) => ({
              date,
              acu: vals.reduce((s, v) => s + v, 0) / vals.length,
            }))
            .sort((a, b) => a.date.localeCompare(b.date));

          return { setup, clusterKey, ok: true, daily, error: null, isSsoExpired: false };
        } catch (error) {
          console.error(`ACU trend failed for setup ${setup}:`, error.message);

          const isSsoExpired = /token is expired|sso session|aws sso login/i.test(error.message || "");

          return { setup, clusterKey, ok: false, daily: [], error: error.message, isSsoExpired };
        }
      })
  );

  // Sum ACU across setups per day (concurrent users across the whole
  // channel, not per-cluster).
  const merged = {};
  for (const { daily } of perSetup) {
    for (const { date, acu } of daily) {
      merged[date] = (merged[date] || 0) + acu;
    }
  }

  const mergedDaily = Object.entries(merged)
    .map(([date, acu]) => ({ date, acu: Number(acu.toFixed(2)) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { perSetup, merged: mergedDaily };
}
