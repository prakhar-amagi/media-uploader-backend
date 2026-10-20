/* =========================================================
   Render-rate RCA — correlation + verdict.

   Deterministic: no LLM decides whether a factor occurred.

   Evidence levels per factor:
     CONFIRMED             error logs directly show the failure
     OBSERVED              measured effect consistent with the factor
                           (user drop is behavioural, not an error)
     NOT_OBSERVED          query succeeded, nothing found
     INSUFFICIENT_EVIDENCE query succeeded but can't decide
     QUERY_FAILED          Athena query failed on every cluster

   Severity uses the share of the hour's ad breaks a factor
   touched (denominator = breaks from AdOpportunitiesDetected),
   so the three factors are comparable despite different units.
   ========================================================= */

import { RENDER_RCA_CONFIG as CFG } from "./config.js";

const SEVERITY_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };
const CONTRIBUTING = new Set(["CONFIRMED", "OBSERVED"]);

export const FACTOR_META = {
  RULE_ENGINE: { label: "Ad assets not transcoded (Rule Engine)", statusCode: "RENDER_TRANSCODE_FAILURE" },
  USER_DROP:   { label: "Users dropped after ad fetch",           statusCode: "RENDER_USER_DROP_AFTER_FETCH" },
  TRACKER:     { label: "Tracker invalid / not fired",            statusCode: "RENDER_TRACKER_FAILURE" },
};

const pct = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);

function severityFrom({ coveragePct, count }) {
  if (coveragePct !== null && coveragePct !== undefined) {
    if (coveragePct >= CFG.coverageHighPct) return "HIGH";
    if (coveragePct >= CFG.coverageMediumPct) return "MEDIUM";
    return coveragePct > 0 || count > 0 ? "LOW" : "NONE";
  }
  if (count >= CFG.countHigh) return "HIGH";
  if (count >= CFG.countMedium) return "MEDIUM";
  return count > 0 ? "LOW" : "NONE";
}

/* ─── Correlation by ad_break_id ──────────────────────────────────────── */

export function correlate({ ruleEngine, userDrop, tracker }) {
  const breaks = new Map();
  const get = (id) => {
    if (!breaks.has(id)) breaks.set(id, { adBreakId: id, factors: [] });
    return breaks.get(id);
  };

  for (const b of userDrop?.breaks || []) {
    if (!b.adBreakId) continue;
    const e = get(b.adBreakId);
    Object.assign(e, {
      opportunityTime: b.opportunityTime,
      breakType: b.breakType,
      durationSeconds: b.durationSeconds,
    });
    e.userDrop = {
      before: b.activeUsersBefore,
      after: b.activeUsersAfter,
      drop: b.userDrop,
      dropPct: b.userDropPct,
      significant: b.significant,
      stale: b.afterSnapshotStale,
    };
    if (b.significant) e.factors.push("USER_DROP");
  }

  for (const [id, r] of Object.entries(ruleEngine?._byBreak || {})) {
    const e = get(id);
    e.ruleEngine = { failures: r.failures, assets: [...r.assets].slice(0, 5), categories: r.categories };
    e.factors.push("RULE_ENGINE");
  }

  for (const [id, t] of Object.entries(tracker?._byBreak || {})) {
    const e = get(id);
    e.tracker = { errors: t.errors, categories: t.categories, assets: [...t.assets].slice(0, 5) };
    e.factors.push("TRACKER");
  }

  const all = [...breaks.values()];
  const multi = all
    .filter((b) => b.factors.length >= 2)
    .sort(
      (a, b) =>
        b.factors.length - a.factors.length ||
        (b.ruleEngine?.failures || 0) + (b.tracker?.errors || 0) - ((a.ruleEngine?.failures || 0) + (a.tracker?.errors || 0))
    );

  // Breaks that had errors but never appeared in AdOpportunitiesDetected —
  // usually means the break started in the previous hour.
  const known = new Set((userDrop?.breaks || []).map((b) => b.adBreakId));
  const outsideWindow = all.filter((b) => !known.has(b.adBreakId)).length;

  return {
    totalBreaksSeen: all.length,
    correlatedBreaks: multi.length,
    breaksOutsideOpportunityWindow: userDrop ? outsideWindow : null,
    allThreeFactors: multi.filter((b) => b.factors.length === 3).length,
    breaks: multi.slice(0, CFG.topN),
  };
}

/* ─── Per-factor assessment ───────────────────────────────────────────── */

function assessRuleEngine(re, q, totalBreaks) {
  const base = { factor: "RULE_ENGINE", label: FACTOR_META.RULE_ENGINE.label, notes: [] };
  if (!q.ok) return { ...base, status: "QUERY_FAILED", severity: "NONE", detail: q.error };

  if (q.truncated) base.notes.push(`Result hit the ${CFG.errorQueryLimit}-row limit; counts are a lower bound.`);
  if (q.partial) base.notes.push(`Query failed on cluster(s): ${q.failedClusters.join(", ")}.`);
  if (re.unclassifiedErrors > 0) {
    base.notes.push(`${re.unclassifiedErrors} Rule Engine error row(s) did not match a known transcode-failure pattern — see "Unclassified signatures".`);
  }
  if (re.failuresWithoutUrl > 0) base.notes.push(`${re.failuresWithoutUrl} failure(s) had no asset URL in the log.`);

  if (re.transcodeFailures === 0) {
    return {
      ...base,
      status: re.unclassifiedErrors > 0 ? "INSUFFICIENT_EVIDENCE" : "NOT_OBSERVED",
      severity: "NONE",
      count: 0,
      detail: re.unclassifiedErrors > 0
        ? "Rule Engine logged errors, but none were recognised as transcode failures."
        : "No Rule Engine errors for this channel in the window.",
    };
  }

  const coveragePct = totalBreaks ? pct(re.affectedAdBreaks, totalBreaks) : null;
  const top = re.byCategory[0];
  const partnerShare = pct(re.byOwner.AD_PARTNER || 0, re.transcodeFailures);

  return {
    ...base,
    status: "CONFIRMED",
    severity: severityFrom({ coveragePct, count: re.transcodeFailures }),
    count: re.transcodeFailures,
    affectedAdBreaks: re.affectedAdBreaks,
    coveragePct,
    detail:
      `${re.transcodeFailures} transcode failure(s) across ${re.uniqueAssets} unique asset(s)` +
      (coveragePct !== null ? `, touching ${re.affectedAdBreaks}/${totalBreaks} ad breaks (${coveragePct}%)` : "") +
      `. Top reason: ${top.label} (${top.occurrences}). ` +
      `${partnerShare}% attributable to ad-partner assets, ${pct(re.byOwner.SSAI_TRANSCODER || 0, re.transcodeFailures)}% to transcoder retries.`,
  };
}

function assessUserDrop(ud, q) {
  const base = { factor: "USER_DROP", label: FACTOR_META.USER_DROP.label, notes: [] };
  if (!q.ok) return { ...base, status: "QUERY_FAILED", severity: "NONE", detail: q.error };
  if (q.partial) base.notes.push(`Query failed on cluster(s): ${q.failedClusters.join(", ")} — audience counts are incomplete.`);

  if (ud.breaksAnalyzed === 0) {
    return { ...base, status: "INSUFFICIENT_EVIDENCE", severity: "NONE", count: 0,
      detail: "No AdOpportunitiesDetected events in the window — no ad breaks to evaluate." };
  }
  if (ud.breaksWithData === 0) {
    return { ...base, status: "INSUFFICIENT_EVIDENCE", severity: "NONE", count: 0,
      detail: `${ud.breaksAnalyzed} ad break(s) found, but none had both before and after ActiveUsers snapshots.` };
  }
  if (ud.breaksMissingSnapshot > 0) base.notes.push(`${ud.breaksMissingSnapshot} break(s) lacked a before/after ActiveUsers snapshot.`);
  if (ud.staleSnapshotBreaks > 0) {
    base.notes.push(`${ud.staleSnapshotBreaks} break(s) had an "after" snapshot more than ${CFG.staleAfterToleranceSec}s past the break end; those drops include unrelated churn.`);
  }

  const coveragePct = pct(ud.significantDropBreaks, ud.breaksAnalyzed);

  if (ud.significantDropBreaks === 0) {
    return { ...base, status: "NOT_OBSERVED", severity: "NONE", count: 0, coveragePct: 0,
      detail: `No ad break showed a drop ≥ ${ud.thresholdPct}%. Hour-weighted change: ${ud.weightedDropPct ?? "n/a"}%.` };
  }

  let severity = severityFrom({ coveragePct, count: ud.significantDropBreaks });
  if (ud.weightedDropPct !== null && ud.weightedDropPct >= CFG.userDropHighPct) severity = "HIGH";

  return {
    ...base,
    status: "OBSERVED",
    severity,
    count: ud.significantDropBreaks,
    affectedAdBreaks: ud.significantDropBreaks,
    coveragePct,
    detail:
      `${ud.significantDropBreaks}/${ud.breaksAnalyzed} ad breaks (${coveragePct}%) lost ≥ ${ud.thresholdPct}% of active users ` +
      `between the ad fetch and the end of the break (${ud.totalUsersDropped} users in total, hour-weighted ${ud.weightedDropPct}%, ` +
      `median ${ud.medianDropPct}%).`,
  };
}

function assessTracker(tr, q, totalBreaks) {
  const base = {
    factor: "TRACKER",
    label: FACTOR_META.TRACKER.label,
    notes: ["Silent non-firing (no error logged) cannot be detected from error logs alone."],
  };
  if (!q.ok) return { ...base, status: "QUERY_FAILED", severity: "NONE", detail: q.error };
  if (q.truncated) base.notes.push(`Result hit the ${CFG.errorQueryLimit}-row limit; counts are a lower bound.`);
  if (q.partial) base.notes.push(`Query failed on cluster(s): ${q.failedClusters.join(", ")}.`);
  if (tr.unclassifiedErrors > 0) base.notes.push(`${tr.unclassifiedErrors} tracker error(s) had no recognised sub-type.`);

  if (tr.totalErrors === 0) {
    return { ...base, status: "NOT_OBSERVED", severity: "NONE", count: 0,
      detail: "No tracker errors logged for this channel in the window." };
  }

  const coveragePct = totalBreaks ? pct(tr.affectedAdBreaks, totalBreaks) : null;
  const top = tr.byCategory[0];
  const topHost = tr.byHost[0];

  return {
    ...base,
    status: "CONFIRMED",
    severity: severityFrom({ coveragePct, count: tr.totalErrors }),
    count: tr.totalErrors,
    affectedAdBreaks: tr.affectedAdBreaks,
    coveragePct,
    detail:
      `${tr.totalErrors} tracker error(s)` +
      (coveragePct !== null ? ` across ${tr.affectedAdBreaks}/${totalBreaks} ad breaks (${coveragePct}%)` : "") +
      `. Top type: ${top.label} (${top.occurrences})` +
      (topHost ? `; most affected endpoint: ${topHost.host} (${topHost.occurrences}).` : "."),
  };
}

/* ─── Overall verdict ─────────────────────────────────────────────────── */

export function buildVerdict({ ruleEngine, userDrop, tracker, queryStatus }) {
  const totalBreaks = queryStatus.userDrop.ok ? userDrop.breaksAnalyzed : 0;

  const factors = [
    assessRuleEngine(ruleEngine, queryStatus.ruleEngine, totalBreaks),
    assessUserDrop(userDrop, queryStatus.userDrop),
    assessTracker(tracker, queryStatus.tracker, totalBreaks),
  ];

  const contributing = factors
    .filter((f) => CONTRIBUTING.has(f.status))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        (b.coveragePct ?? -1) - (a.coveragePct ?? -1) ||
        (a.status === "CONFIRMED" ? -1 : 1)
    );

  const failedQueries = factors.filter((f) => f.status === "QUERY_FAILED");
  const caveats = [
    "No baseline comparison: counts describe this hour only. Compare with a normal hour before treating a factor as the cause.",
  ];
  if (failedQueries.length) caveats.push(`Missing data: ${failedQueries.map((f) => f.label).join(", ")}.`);
  const partialClusters = [...new Set(Object.values(queryStatus).flatMap((s) => (s.partial ? s.failedClusters : [])))];
  if (partialClusters.length) caveats.push(`Incomplete data: queries failed on cluster(s) ${partialClusters.join(", ")}; numbers cover the remaining clusters only.`);
  const truncated = Object.values(queryStatus).some((s) => s.truncated);

  let status, headline, reason, confidence, primaryFactor = null;

  if (failedQueries.length === 3) {
    status = "RENDER_NO_DATA";
    headline = "Could not retrieve any Athena data";
    reason = "All three queries failed. Check the AWS SSO connection and the diagnostics below.";
    confidence = "NONE";
  } else if (!contributing.length) {
    status = "RENDER_NO_FACTOR_FOUND";
    headline = "None of the three render-rate factors were found";
    reason =
      "No transcode failures, tracker errors, or significant post-fetch user drop in this hour. " +
      "If render rate still dropped, check upstream: demand fill and ad-response volume (Impression RCA), or ad-marker detection.";
    confidence = failedQueries.length ? "LOW" : "MEDIUM";
  } else {
    primaryFactor = contributing[0].factor;
    status = contributing.length > 1 ? "RENDER_MULTI_FACTOR" : FACTOR_META[primaryFactor].statusCode;
    headline =
      contributing.length > 1
        ? `${contributing.length} contributing factors — primary: ${contributing[0].label}`
        : contributing[0].label;
    reason = contributing.map((f) => f.detail).join(" ");

    const p = contributing[0];
    if (failedQueries.length) confidence = "LOW";
    else if (p.status === "CONFIRMED" && p.severity === "HIGH" && !partialClusters.length && !truncated) confidence = "HIGH";
    else if (SEVERITY_RANK[p.severity] >= 2) confidence = "MEDIUM";
    else confidence = "LOW";
  }

  return {
    status,
    headline,
    reason,
    confidence,
    primaryFactor,
    contributingFactors: contributing.map((f) => f.factor),
    factors,
    caveats,
  };
}

/* ─── Plain-text report (copy/paste into a ticket) ───────────────────── */

export function buildTextReport({ input, verdict, ruleEngine, userDrop, tracker, correlation }) {
  const L = [];
  L.push(`Render Rate RCA — ${input.channelId}`);
  L.push(`Window: ${input.windowStart} → ${input.windowEnd} (UTC)   Clusters: ${input.clusters.join(", ") || "n/a"}`);
  L.push("");
  L.push(`Verdict: ${verdict.headline}  [confidence: ${verdict.confidence}]`);
  L.push(verdict.reason);
  L.push("");

  for (const f of verdict.factors) {
    L.push(`■ ${f.label} — ${f.status}${f.severity && f.severity !== "NONE" ? ` (${f.severity})` : ""}`);
    if (f.detail) L.push(`  ${f.detail}`);
    for (const n of f.notes || []) L.push(`  • ${n}`);
  }

  if (ruleEngine?.groupedAssets?.length) {
    L.push("");
    L.push("Failed ad assets (unique, by frequency):");
    for (const a of ruleEngine.groupedAssets.slice(0, 15)) {
      L.push(`  ${String(a.occurrences).padStart(5)}×  ${a.primaryLabel}  ${a.assetUrl || a.assetKey}`);
    }
  }

  if (userDrop?.significantDrops?.length) {
    L.push("");
    L.push(`Largest post-fetch user drops (≥ ${userDrop.thresholdPct}%):`);
    for (const b of userDrop.significantDrops.slice(0, 10)) {
      L.push(`  ${b.adBreakId}  ${b.activeUsersBefore} → ${b.activeUsersAfter}  (-${b.userDrop}, ${b.userDropPct}%)`);
    }
  }

  if (tracker?.byCategory?.length) {
    L.push("");
    L.push("Tracker errors:");
    for (const c of tracker.byCategory) L.push(`  ${String(c.occurrences).padStart(5)}×  ${c.label}`);
  }

  if (correlation?.correlatedBreaks) {
    L.push("");
    L.push(`Ad breaks hit by more than one factor: ${correlation.correlatedBreaks}`);
  }

  L.push("");
  for (const c of verdict.caveats) L.push(`Note: ${c}`);
  return L.join("\n");
}
