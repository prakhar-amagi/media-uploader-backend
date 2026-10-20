import {
  pctChange,
  isSignificantDrop,
  analyzeDemandTagPerformance,
} from "./demandTagRules.js";

/**
 * Split a day-wise series into a "past" window and a "current" window
 * of equal length (first half vs second half), sum/average each side,
 * and compute percent change — mirroring the current/past framing
 * SpringServe quickstats uses, but built from real daily rows.
 */
export function summarizeAthenaTrend(rows) {
  if (!rows || rows.length < 2) {
    return { daily: rows || [], pastWindow: null, currentWindow: null, changePercent: {} };
  }

  const mid = Math.floor(rows.length / 2);
  const pastRows = rows.slice(0, mid);
  const currentRows = rows.slice(mid);

  const sum = (list, field) => list.reduce((acc, r) => acc + (r[field] ?? 0), 0);
  const fields = ["detections", "requests", "usable_ads", "impressions"];

  const pastWindow = {};
  const currentWindow = {};
  const changePercent = {};

  for (const field of fields) {
    pastWindow[field] = sum(pastRows, field);
    currentWindow[field] = sum(currentRows, field);
    changePercent[field] = pctChange({
      current_value: currentWindow[field],
      past_value: pastWindow[field],
    });
  }

  return { daily: rows, pastWindow, currentWindow, changePercent };
}

export function summarizeAcuTrend(dailyAcu) {
  if (!dailyAcu || dailyAcu.length < 2) {
    return { daily: dailyAcu || [], pastAvg: null, currentAvg: null, changePercent: null };
  }

  const mid = Math.floor(dailyAcu.length / 2);
  const pastRows = dailyAcu.slice(0, mid);
  const currentRows = dailyAcu.slice(mid);

  const avg = (rows) => rows.reduce((s, r) => s + r.acu, 0) / rows.length;

  const pastAvg = avg(pastRows);
  const currentAvg = avg(currentRows);
  const changePercent = pctChange({ current_value: currentAvg, past_value: pastAvg });

  return { daily: dailyAcu, pastAvg, currentAvg, changePercent };
}

/* =========================================================
   SpringServe /dashboards/tag_performance normalization.

   Raw response shape: { day: [ { ymdh, usable_requests,
   impressions, has_ads, opportunities, fill_rate,
   opportunity_fill_rate, ... }, ... ], hour: [...], ... }
   (only the field matching the requested `interval` is populated).

   Rate fields (fill_rate, opportunity_fill_rate, efficiency_rate,
   opportunity_rate, ad_rate, completion_rate,
   click_through_rate) come back as 0-1 fractions — converted to
   percentages here (*100) for display/comparison consistency with
   the rest of the app.
   ========================================================= */

const SPRINGSERVE_COUNT_FIELDS = [
  "usable_requests", "impressions", "has_ads", "opportunities",
  "fourth_quartile", "clicks", "revenue", "cost",
];

const SPRINGSERVE_RATE_FIELDS = [
  "fill_rate", "opportunity_fill_rate", "efficiency_rate",
  "opportunity_rate", "ad_rate", "completion_rate",
  "click_through_rate",
];

export const SPRINGSERVE_INTERVALS = ["day", "hour"];

/** Parse SpringServe's ymdh ("2026-10-03 10:00:00", ISO, …) to epoch ms (UTC). */
function parseYmdh(ymdh) {
  if (!ymdh) return NaN;
  let s = String(ymdh).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(s)) s += ":00:00";
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
  return Date.parse(s);
}

export function normalizeSpringservePerformance(rawResponse, interval = "day") {
  // Only read the key matching the requested interval. Falling back to
  // `day` when `hour` is missing would silently mislabel daily rows as hours.
  const rows = rawResponse?.[interval] || [];

  return rows.map((row) => {
    const tsMs = parseYmdh(row.ymdh);
    const iso = Number.isNaN(tsMs) ? String(row.ymdh || "") : new Date(tsMs).toISOString();
    const out = {
      date: iso.slice(0, 10),
      ts: interval === "hour" ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10),
      hour: interval === "hour" && !Number.isNaN(tsMs) ? new Date(tsMs).getUTCHours() : null,
      _ms: tsMs,
    };

    for (const field of SPRINGSERVE_COUNT_FIELDS) {
      out[field] = row[field] ?? 0;
    }
    for (const field of SPRINGSERVE_RATE_FIELDS) {
      out[field] = row[field] !== undefined && row[field] !== null
        ? Number((row[field] * 100).toFixed(2))
        : 0;
    }

    return out;
  }).sort((a, b) => (a._ms - b._ms) || a.ts.localeCompare(b.ts));
}

/**
 * Trim to the requested window by TIME, not row count (the API ignores
 * date_range and returns more than asked for).
 *   day:  last `days` calendar days present in the data
 *   hour: last `hours` hours, ending at the latest row
 */
export function trimSpringserveWindow(rows, { interval = "day", days = 30, hours = 24 } = {}) {
  if (!rows.length) return rows;

  if (interval === "hour") {
    const latest = rows[rows.length - 1]._ms;
    const from = latest - (Number(hours) - 1) * 3600 * 1000;
    return rows.filter((r) => r._ms >= from);
  }

  const n = Number(days);
  if (!n || n <= 0 || n >= rows.length) return rows;
  return rows.slice(-n);
}

/**
 * Hourly comparison. Halves of an hourly series compare different times
 * of day (night vs. prime time), so instead each hour in the window is
 * compared with the SAME clock hour on previous days, averaged over up to
 * `maxBaselineDays` days. Output shape matches summarizeSpringservePerformance
 * so analyzeDemandTagPerformance() works unchanged.
 */
export function summarizeSpringserveHourly(allRows, { hours = 24, maxBaselineDays = 7 } = {}) {
  const current = trimSpringserveWindow(allRows, { interval: "hour", hours });
  if (!current.length) {
    return { daily: [], pastWindow: null, currentWindow: null, changePercent: {}, interval: "hour" };
  }

  const byMs = new Map(allRows.map((r) => [r._ms, r]));
  const DAY = 24 * 3600 * 1000;
  const fields = [...SPRINGSERVE_COUNT_FIELDS, ...SPRINGSERVE_RATE_FIELDS];
  let baselineDaysUsed = 0;

  const rowsWithBaseline = current.map((row) => {
    const prior = [];
    for (let k = 1; k <= maxBaselineDays; k++) {
      const p = byMs.get(row._ms - k * DAY);
      if (p) { prior.push(p); baselineDaysUsed = Math.max(baselineDaysUsed, k); }
    }
    if (!prior.length) return { ...row, baseline: null, baselineDays: 0 };

    const baseline = {};
    for (const f of fields) {
      baseline[f] = Number((prior.reduce((acc, p) => acc + (p[f] ?? 0), 0) / prior.length).toFixed(2));
    }
    return {
      ...row,
      baseline,
      baselineDays: prior.length,
      impressionsChangePct: pctChange({ current_value: row.impressions, past_value: baseline.impressions }),
    };
  });

  // Only hours that have a baseline count towards the comparison.
  const compared = rowsWithBaseline.filter((r) => r.baseline);
  if (!compared.length) {
    return {
      daily: rowsWithBaseline, pastWindow: null, currentWindow: null, changePercent: {},
      interval: "hour", baselineDays: 0, comparedHours: 0,
      note: "No earlier days in the data to compare these hours against.",
    };
  }

  const pastWindow = {};
  const currentWindow = {};
  const changePercent = {};

  for (const f of SPRINGSERVE_COUNT_FIELDS) {
    currentWindow[f] = compared.reduce((a, r) => a + (r[f] ?? 0), 0);
    pastWindow[f] = Number(compared.reduce((a, r) => a + r.baseline[f], 0).toFixed(2));
    changePercent[f] = pctChange({ current_value: currentWindow[f], past_value: pastWindow[f] });
  }
  for (const f of SPRINGSERVE_RATE_FIELDS) {
    currentWindow[f] = Number((compared.reduce((a, r) => a + (r[f] ?? 0), 0) / compared.length).toFixed(2));
    pastWindow[f] = Number((compared.reduce((a, r) => a + r.baseline[f], 0) / compared.length).toFixed(2));
    changePercent[f] = pctChange({ current_value: currentWindow[f], past_value: pastWindow[f] });
  }

  return {
    daily: rowsWithBaseline,
    pastWindow,
    currentWindow,
    changePercent,
    interval: "hour",
    baselineDays: baselineDaysUsed,
    comparedHours: compared.length,
  };
}

const stripInternal = (rows) => rows.map(({ _ms, ...r }) => r);

/**
 * One entry point for both intervals.
 *   day:  last `days` days, first half vs second half (unchanged behaviour)
 *   hour: last `hours` hours vs the same hours on previous days
 */
export function analyzeSpringserveSeries(raw, { interval = "day", days = 30, hours = 24 } = {}) {
  const all = normalizeSpringservePerformance(raw, interval);

  if (interval === "hour") {
    const summary = summarizeSpringserveHourly(all, { hours });
    const rows = stripInternal(summary.daily);
    return {
      interval,
      rows,
      summary: { ...summary, daily: rows },
      window: {
        hours: Number(hours),
        from: rows[0]?.ts ?? null,
        to: rows[rows.length - 1]?.ts ?? null,
        baselineDays: summary.baselineDays ?? 0,
        comparedHours: summary.comparedHours ?? 0,
        comparison: "same hours on previous days",
        rowsReturnedByApi: all.length,
      },
    };
  }

  const trimmed = stripInternal(trimSpringserveWindow(all, { interval, days }));
  const summary = summarizeSpringservePerformance(trimmed);
  return {
    interval,
    rows: trimmed,
    summary,
    window: {
      days: Number(days),
      from: trimmed[0]?.date ?? null,
      to: trimmed[trimmed.length - 1]?.date ?? null,
      comparison: "first half vs second half",
      rowsReturnedByApi: all.length,
    },
  };
}

/**
 * Split normalized day-wise SpringServe rows into past/current
 * windows (first half vs second half, matching Athena's approach).
 * Count fields are summed; rate fields are averaged (they're
 * already ratios, not counts, so summing them would be wrong).
 */
export function summarizeSpringservePerformance(dailyRows) {
  if (!dailyRows || dailyRows.length < 2) {
    return { daily: dailyRows || [], pastWindow: null, currentWindow: null, changePercent: {} };
  }

  const mid = Math.floor(dailyRows.length / 2);
  const pastRows = dailyRows.slice(0, mid);
  const currentRows = dailyRows.slice(mid);

  const sum = (list, field) => list.reduce((acc, r) => acc + (r[field] ?? 0), 0);
  const avg = (list, field) => sum(list, field) / list.length;

  const pastWindow = {};
  const currentWindow = {};
  const changePercent = {};

  for (const field of SPRINGSERVE_COUNT_FIELDS) {
    pastWindow[field] = sum(pastRows, field);
    currentWindow[field] = sum(currentRows, field);
    changePercent[field] = pctChange({ current_value: currentWindow[field], past_value: pastWindow[field] });
  }

  for (const field of SPRINGSERVE_RATE_FIELDS) {
    pastWindow[field] = Number(avg(pastRows, field).toFixed(2));
    currentWindow[field] = Number(avg(currentRows, field).toFixed(2));
    changePercent[field] = pctChange({ current_value: currentWindow[field], past_value: pastWindow[field] });
  }

  return { daily: dailyRows, pastWindow, currentWindow, changePercent };
}

/**
 * Full funnel RCA: ACU (users) -> Athena (detections -> requests ->
 * usable_ads -> impressions) -> SpringServe demand-tag verdict.
 *
 * Mirrors the manual decision tree:
 *   ACU (users) down               -> traffic/viewership issue
 *   detections down                -> content partner not sending ad markers
 *   detections+ACU ok, requests down -> ad request generation / SSAI issue
 *   requests ok, usable_ads down   -> defer to SpringServe demand analysis
 *   usable_ads ok, impressions down -> playback/measurement issue
 *   everything ~0                  -> traffic/source issue (channel likely down)
 */
export function analyzeFullRca({ athenaSummary, acuSummary, springserveSummary }) {
  const c = athenaSummary?.changePercent || {};
  const demandRca = analyzeDemandTagPerformance(springserveSummary);

  const evidence = {
    acu: {
      pastAvg: acuSummary?.pastAvg,
      currentAvg: acuSummary?.currentAvg,
      changePercent: acuSummary?.changePercent,
    },
    athena: {
      pastWindow: athenaSummary?.pastWindow,
      currentWindow: athenaSummary?.currentWindow,
      changePercent: c,
    },
    springserve: demandRca.evidence,
  };

  const currentAllZero =
    athenaSummary?.currentWindow &&
    Object.values(athenaSummary.currentWindow).every((v) => v === 0);

  if (currentAllZero) {
    return {
      status: "TRAFFIC_SOURCE_ISSUE",
      confidence: "HIGH",
      reason:
        "Detections, requests, usable ads, and impressions are all effectively zero " +
        "in the current window. This looks like a channel/source-level issue, not demand.",
      evidence,
      demandRca: null,
    };
  }

  if (isSignificantDrop(acuSummary?.changePercent)) {
    return {
      status: "TRAFFIC_VIEWERSHIP_ISSUE",
      confidence: "MEDIUM",
      reason:
        `Concurrent users (ACU) dropped ${acuSummary.changePercent}% versus the prior window. ` +
        `This is a viewership/traffic issue upstream of ad decisioning — check with the platform ` +
        `about distribution/carriage before looking at ad markers or demand.`,
      evidence,
      demandRca: null,
    };
  }

  if (isSignificantDrop(c.detections)) {
    return {
      status: "AD_MARKER_DETECTION_ISSUE",
      confidence: "HIGH",
      reason:
        `Ad-marker detections dropped ${c.detections}% versus the prior window, while users are ` +
        `stable. Check with the content partner about SCTE/ad-marker insertion for this channel ` +
        `before looking at SpringServe demand.`,
      evidence,
      demandRca: null,
    };
  }

  if (isSignificantDrop(c.requests)) {
    return {
      status: "AD_REQUEST_GENERATION_ISSUE",
      confidence: "MEDIUM",
      reason:
        `Users and detections are stable, but ad requests dropped ${c.requests}%. This points to ` +
        `an issue generating ad requests from detected markers (SSAI/player-side).`,
      evidence,
      demandRca: null,
    };
  }

  if (isSignificantDrop(c.usable_ads)) {
    return {
      status: demandRca.status,
      confidence: demandRca.confidence,
      reason:
        `Users, detections, and requests are all stable, but usable ads dropped ${c.usable_ads}%. ` +
        `This is a demand-side issue — ` + demandRca.reason,
      evidence,
      demandRca,
    };
  }

  if (isSignificantDrop(c.impressions)) {
    return {
      status: "PLAYBACK_OR_MEASUREMENT_ISSUE",
      confidence: "LOW",
      reason:
        `Users, detections, requests, and usable ads all look normal, but impressions dropped ` +
        `${c.impressions}%. Likely a playback or measurement/beaconing issue downstream of ad ` +
        `decisioning.`,
      evidence,
      demandRca,
    };
  }

  return {
    status: "NO_SIGNIFICANT_CHANGE",
    confidence: "HIGH",
    reason: "No significant change detected across users, detections, requests, usable ads, or impressions.",
    evidence,
    demandRca,
  };
}
