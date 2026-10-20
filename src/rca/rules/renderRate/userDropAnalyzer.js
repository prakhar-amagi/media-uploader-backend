/* =========================================================
   Factor 2 — Users drop the stream after the ad is fetched.

   Input: rows from buildUserDropQuery (one per ad break, per
   cluster). When a channel is split across clusters, the same
   ad_break_id appears once per cluster; before/after counts are
   summed so the break reflects the channel's whole audience.

   The query also returns EVERY ad break in the hour, which the
   verdict layer uses as the denominator for "share of breaks
   affected" by each factor.
   ========================================================= */

import { RENDER_RCA_CONFIG } from "./config.js";

const toNum = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

function mergeAcrossClusters(rows) {
  const byBreak = new Map();

  for (const r of rows) {
    const id = r.ad_break_id || `${r._cluster}:${r.opportunity_time}`;
    const before = toNum(r.active_users_before);
    const after = toNum(r.active_users_after);

    if (!byBreak.has(id)) {
      byBreak.set(id, {
        adBreakId: r.ad_break_id || null,
        opportunityTime: r.opportunity_time,
        segmentId: r.segment_id || null,
        breakType: r.break_type || null,
        durationSeconds: toNum(r.duration_seconds) ?? 0,
        adOpportunities: 0,
        activeUsersBefore: null,
        activeUsersAfter: null,
        beforeTime: r.active_users_before_time || null,
        afterTime: r.active_users_after_time || null,
        maxSecondsAfterOpportunity: null,
        clusters: [],
        missingBefore: false,
        missingAfter: false,
      });
    }

    const b = byBreak.get(id);
    if (r._cluster) b.clusters.push(r._cluster);
    if (r.opportunity_time && r.opportunity_time < b.opportunityTime) b.opportunityTime = r.opportunity_time;
    b.adOpportunities += toNum(r.ad_opportunities) || 0;

    if (before === null) b.missingBefore = true;
    else b.activeUsersBefore = (b.activeUsersBefore || 0) + before;

    if (after === null) b.missingAfter = true;
    else b.activeUsersAfter = (b.activeUsersAfter || 0) + after;

    const secs = toNum(r.actual_seconds_after_opportunity);
    if (secs !== null) b.maxSecondsAfterOpportunity = Math.max(b.maxSecondsAfterOpportunity ?? secs, secs);
  }

  return [...byBreak.values()];
}

export function analyzeUserDrop(rows, { thresholdPct = RENDER_RCA_CONFIG.userDropThresholdPct } = {}) {
  const breaks = mergeAcrossClusters(rows).map((b) => {
    const hasData = !b.missingBefore && !b.missingAfter && b.activeUsersBefore !== null && b.activeUsersAfter !== null;
    const drop = hasData ? b.activeUsersBefore - b.activeUsersAfter : null;
    const dropPct = hasData && b.activeUsersBefore > 0 ? round2((100 * drop) / b.activeUsersBefore) : null;

    // The "after" snapshot should land shortly after the break ends; if it
    // is far later, the drop also includes unrelated churn.
    const lagSec =
      b.maxSecondsAfterOpportunity !== null ? b.maxSecondsAfterOpportunity - b.durationSeconds : null;
    const afterSnapshotStale = lagSec !== null && lagSec > RENDER_RCA_CONFIG.staleAfterToleranceSec;

    return {
      ...b,
      hasData,
      userDrop: drop,
      userDropPct: dropPct,
      afterSnapshotLagSec: lagSec,
      afterSnapshotStale,
      significant: dropPct !== null && dropPct >= thresholdPct,
    };
  });

  const withData = breaks.filter((b) => b.hasData);
  const sumBefore = withData.reduce((s, b) => s + b.activeUsersBefore, 0);
  const sumNetDrop = withData.reduce((s, b) => s + b.userDrop, 0);
  const sumPositiveDrop = withData.reduce((s, b) => s + Math.max(0, b.userDrop), 0);
  const significant = breaks.filter((b) => b.significant);

  const breakIds = breaks.map((b) => b.adBreakId).filter(Boolean);

  return {
    thresholdPct,
    breaksAnalyzed: breaks.length,
    breaksWithData: withData.length,
    breaksMissingSnapshot: breaks.length - withData.length,
    breaksWithAnyDrop: withData.filter((b) => b.userDrop > 0).length,
    significantDropBreaks: significant.length,
    staleSnapshotBreaks: breaks.filter((b) => b.afterSnapshotStale).length,
    totalUsersBefore: sumBefore,
    totalUsersDropped: sumPositiveDrop,
    weightedDropPct: sumBefore > 0 ? round2((100 * sumNetDrop) / sumBefore) : null,
    medianDropPct: round2(median(withData.map((b) => b.userDropPct).filter((v) => v !== null))),
    maxDropPct: withData.length ? Math.max(...withData.map((b) => b.userDropPct ?? -Infinity)) : null,
    significantDrops: significant.sort((a, b) => b.userDropPct - a.userDropPct),
    breaks: breaks.sort((a, b) => String(a.opportunityTime).localeCompare(String(b.opportunityTime))),
    allAdBreakIds: breakIds,
    affectedAdBreakIds: significant.map((b) => b.adBreakId).filter(Boolean),
  };
}
