/* =========================================================
   RCA rules for a single demand tag, based on day-wise data
   from SpringServe v1 /dashboards/tag_performance (interval=day).

   Row shape per day:
   {
     ymdh, usable_requests, impressions, has_ads, opportunities,
     fill_rate, opportunity_fill_rate, efficiency_rate,
     opportunity_rate, ad_rate, use_rate, completion_rate,
     click_through_rate, revenue, cost, clicks, fourth_quartile, ...
   }

   NOTE: this endpoint gives real daily rows, unlike quickstats
   (which only gave a current-period-vs-past-period aggregate).
   It also has NO timeout/timeout_rate fields, so the old
   DEMAND_TIMEOUT_ISSUE branch isn't derivable from this data
   source anymore.
   ========================================================= */

const SIGNIFICANT_DROP_PCT = -15; // treat anything worse than this as a real decline
const SIGNIFICANT_RISE_PCT = 15;

export function pctChange(metric) {
  if (!metric) return null;

  const current = Number(metric.current_value ?? 0);
  const past = Number(metric.past_value ?? 0);

  if (past === 0) {
    // Can't compute a meaningful percentage off a zero baseline.
    return current === 0 ? 0 : null;
  }

  return Number((((current - past) / past) * 100).toFixed(1));
}

export function isSignificantDrop(pct) {
  return pct !== null && pct <= SIGNIFICANT_DROP_PCT;
}

export function isSignificantRise(pct) {
  return pct !== null && pct >= SIGNIFICANT_RISE_PCT;
}

/**
 * Analyze one demand tag's day-wise tag_performance data and produce
 * an RCA verdict that mirrors the manual decision tree:
 *
 *   usable_requests down?
 *     -> upstream issue (traffic / ad detection), not SpringServe
 *   requests normal, opportunities/has_ads (bids) down?
 *     -> demand partner returning fewer usable bids
 *   requests + opportunities normal, fill_rate down?
 *     -> demand partner filling less of what it says it can
 *   everything upstream normal but impressions still down?
 *     -> likely downstream (playback/measurement), outside SpringServe
 *
 * `summary` is the output of summarizeSpringservePerformance() in
 * fullAnalysis.js — { pastWindow, currentWindow, changePercent }.
 */
export function analyzeDemandTagPerformance(summary) {
  if (!summary || !summary.changePercent) {
    return {
      status: "NO_DATA",
      confidence: "NONE",
      reason: "No tag performance data available for this demand tag.",
      evidence: {},
    };
  }

  const c = summary.changePercent;
  const evidence = { changePercent: c, pastWindow: summary.pastWindow, currentWindow: summary.currentWindow };

  // 1. Requests themselves dropped -> the problem is upstream of
  //    SpringServe (traffic to the channel, or ad-marker detection),
  //    not the demand partner.
  if (isSignificantDrop(c.usable_requests)) {
    return {
      status: "UPSTREAM_TRAFFIC_OR_DETECTION",
      confidence: "MEDIUM",
      reason:
        `Usable requests to this demand tag dropped ${c.usable_requests}% ` +
        `versus the prior period. This points upstream of SpringServe — ` +
        `check ad-marker detection counts (Athena) and user/session ` +
        `trend (Grafana) for this channel before looking further into demand.`,
      evidence,
    };
  }

  // 2. Requests are fine, but usable opportunities/bids (has_ads) dropped ->
  //    the demand partner is returning fewer usable bid opportunities.
  if (isSignificantDrop(c.opportunities) || isSignificantDrop(c.has_ads)) {
    return {
      status: "DEMAND_OPPORTUNITY_DECLINE",
      confidence: "HIGH",
      reason:
        `Requests are stable (${c.usable_requests ?? "n/a"}%), but bids/opportunities ` +
        `dropped ${c.opportunities ?? c.has_ads}%. The demand partner is returning ` +
        `fewer usable bids for requests it is receiving.`,
      evidence,
    };
  }

  // 3. Requests + opportunities fine, but fill rate dropped -> demand
  //    partner is filling less of what it has the opportunity to fill.
  if (isSignificantDrop(c.fill_rate) || isSignificantDrop(c.opportunity_fill_rate)) {
    return {
      status: "DEMAND_FILL_DECLINE",
      confidence: "HIGH",
      reason:
        `Requests and opportunities are stable, but fill rate dropped ` +
        `${c.fill_rate ?? c.opportunity_fill_rate}%. This is a demand-side ` +
        `availability/pricing issue — worth raising with the demand partner directly.`,
      evidence,
    };
  }

  // Note: this endpoint has no timeout/timeout_rate fields, so a
  // timeout-based branch isn't derivable here (unlike the old
  // quickstats-based version). If that signal matters, it would need
  // to come from a separate SpringServe call.

  // 4. Impressions dropped but nothing upstream in the funnel explains it
  //    -> likely a downstream (playback/measurement) issue outside SpringServe.
  if (isSignificantDrop(c.impressions)) {
    return {
      status: "DOWNSTREAM_OR_MEASUREMENT",
      confidence: "LOW",
      reason:
        `Impressions dropped ${c.impressions}% but requests, opportunities, ` +
        `and fill rate all look normal for this demand tag. The issue is likely ` +
        `downstream of ad decisioning (playback, ad insertion, or measurement) ` +
        `rather than SpringServe demand.`,
      evidence,
    };
  }

  // 5. Nothing significant changed.
  return {
    status: "NO_SIGNIFICANT_CHANGE",
    confidence: "HIGH",
    reason: "No significant change detected across requests, fill, or impressions for this demand tag.",
    evidence,
  };
}
