/* =========================================================
   Factor 1 — Ad assets not transcoded by the Rule Engine.

   Input: core_rule_engine level=error rows (one or more clusters,
   each row tagged with `_cluster`).

   Output answers: how many assets failed, why, which URLs, and
   how often each unique asset failed.
   ========================================================= */

import {
  RULE_ENGINE_RULES,
  classify,
  parseMeta,
  extractAssetUrl,
  extractCreativeId,
  extractProfile,
  assetKey,
  messageSignature,
} from "./classifiers.js";
import { RENDER_RCA_CONFIG } from "./config.js";

const NO_URL_KEY = "(asset URL not present in log)";

function bump(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

function topKey(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

export function analyzeRuleEngine(rows, { topN = RENDER_RCA_CONFIG.topN } = {}) {
  const failures = rows.map((row) => {
    const meta = parseMeta(row.meta);
    const c = classify(row, RULE_ENGINE_RULES);
    const assetUrl = extractAssetUrl(row, meta);

    return {
      ts: row.ts,
      cluster: row._cluster || null,
      adBreakId: row.ad_break_id || null,
      requestId: row.request_id || null,
      userId: row.user_id || null,
      podName: row.pod_name || null,
      assetUrl,
      assetKey: assetKey(assetUrl),
      creativeId: extractCreativeId(row, meta),
      profile: extractProfile(meta),
      category: c.category,
      label: c.label,
      owner: c.owner,
      matchedOn: c.matchedOn,
      message: row.msg || null,
      error: row.err || row.reason || null,
    };
  });

  const classified = failures.filter((f) => f.category !== "UNCLASSIFIED");
  const unclassified = failures.filter((f) => f.category === "UNCLASSIFIED");

  /* ── Group by unique asset ── */
  const assets = new Map();
  for (const f of classified) {
    const key = f.assetKey || NO_URL_KEY;
    if (!assets.has(key)) {
      assets.set(key, {
        assetKey: key,
        assetUrl: f.assetUrl,
        hasUrl: !!f.assetUrl,
        occurrences: 0,
        categories: {},
        requests: new Set(),
        adBreaks: new Set(),
        profiles: new Set(),
        creativeIds: new Set(),
        clusters: new Set(),
        firstSeen: f.ts,
        lastSeen: f.ts,
      });
    }
    const a = assets.get(key);
    a.occurrences++;
    bump(a.categories, f.category);
    if (f.requestId) a.requests.add(f.requestId);
    if (f.adBreakId) a.adBreaks.add(f.adBreakId);
    if (f.profile) a.profiles.add(f.profile);
    if (f.creativeId) a.creativeIds.add(f.creativeId);
    if (f.cluster) a.clusters.add(f.cluster);
    if (f.ts && f.ts < a.firstSeen) a.firstSeen = f.ts;
    if (f.ts && f.ts > a.lastSeen) a.lastSeen = f.ts;
  }

  const ruleByCategory = Object.fromEntries(RULE_ENGINE_RULES.map((r) => [r.category, r]));

  const groupedAssets = [...assets.values()]
    .map((a) => {
      const primary = topKey(a.categories);
      return {
        assetKey: a.assetKey,
        assetUrl: a.assetUrl,
        hasUrl: a.hasUrl,
        occurrences: a.occurrences,
        distinctRequests: a.requests.size,
        distinctAdBreaks: a.adBreaks.size,
        primaryCategory: primary,
        primaryLabel: ruleByCategory[primary]?.label || primary,
        owner: ruleByCategory[primary]?.owner || "UNKNOWN",
        categories: a.categories,
        profiles: [...a.profiles],
        creativeIds: [...a.creativeIds],
        clusters: [...a.clusters],
        firstSeen: a.firstSeen,
        lastSeen: a.lastSeen,
      };
    })
    .sort((x, y) => y.occurrences - x.occurrences);

  /* ── Breakdown by failure reason ── */
  const byCategory = RULE_ENGINE_RULES.map((rule) => {
    const items = classified.filter((f) => f.category === rule.category);
    return {
      category: rule.category,
      label: rule.label,
      owner: rule.owner,
      occurrences: items.length,
      uniqueAssets: new Set(items.map((f) => f.assetKey || NO_URL_KEY)).size,
      adBreaks: new Set(items.map((f) => f.adBreakId).filter(Boolean)).size,
    };
  })
    .filter((c) => c.occurrences > 0)
    .sort((a, b) => b.occurrences - a.occurrences);

  const byOwner = {};
  for (const f of classified) bump(byOwner, f.owner);

  /* ── Unclassified signatures (to tune classifiers.js) ── */
  const sigMap = new Map();
  for (const f of unclassified) {
    const sig = messageSignature({ msg: f.message, err: f.error });
    if (!sigMap.has(sig)) sigMap.set(sig, { signature: sig, count: 0, sample: f.error || f.message, caller: null });
    sigMap.get(sig).count++;
  }
  const unclassifiedSignatures = [...sigMap.values()].sort((a, b) => b.count - a.count).slice(0, 15);

  const affectedAdBreakIds = [...new Set(classified.map((f) => f.adBreakId).filter(Boolean))];

  return {
    totalErrorRows: failures.length,
    transcodeFailures: classified.length,
    unclassifiedErrors: unclassified.length,
    uniqueAssets: groupedAssets.filter((a) => a.hasUrl).length,
    failuresWithoutUrl: classified.filter((f) => !f.assetUrl).length,
    affectedAdBreakIds,
    affectedAdBreaks: affectedAdBreakIds.length,
    byCategory,
    byOwner,
    groupedAssets: groupedAssets.slice(0, topN),
    groupedAssetsTotal: groupedAssets.length,
    unclassifiedSignatures,
    /* per-break index for correlation (not sent to the UI as-is) */
    _byBreak: indexByBreak(classified),
  };
}

function indexByBreak(failures) {
  const idx = {};
  for (const f of failures) {
    if (!f.adBreakId) continue;
    const b = (idx[f.adBreakId] ||= { failures: 0, assets: new Set(), categories: {} });
    b.failures++;
    if (f.assetKey) b.assets.add(f.assetKey);
    bump(b.categories, f.category);
  }
  return idx;
}
