/* =========================================================
   Factor 3 — Tracker invalid / not fired.

   Input: core_tracker level=error rows.

   Note on "not fired": a tracker that silently never fires
   produces no error row, so error logs can CONFIRM firing
   failures but can never rule silent non-firing out. The
   verdict layer reports that explicitly.
   ========================================================= */

import {
  TRACKER_RULES,
  classify,
  parseMeta,
  extractAssetUrl,
  urlHost,
  extractHttpStatus,
  messageSignature,
} from "./classifiers.js";
import { RENDER_RCA_CONFIG } from "./config.js";

function bump(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

export function analyzeTracker(rows, { topN = RENDER_RCA_CONFIG.topN } = {}) {
  const errors = rows.map((row) => {
    const meta = parseMeta(row.meta);
    const c = classify(row, TRACKER_RULES);
    const url = extractAssetUrl(row, meta);
    return {
      ts: row.ts,
      cluster: row._cluster || null,
      adBreakId: row.ad_break_id || null,
      segmentId: row.segment_id || null,
      assetId: row.asset_id || null,
      requestId: row.request_id || null,
      trackerUrl: url,
      trackerHost: urlHost(url),
      httpStatus: extractHttpStatus(row),
      category: c.category,
      label: c.label,
      owner: c.owner,
      message: row.msg || null,
      error: row.err || row.reason || null,
    };
  });

  const ruleByCategory = Object.fromEntries(TRACKER_RULES.map((r) => [r.category, r]));

  /* ── By category ── */
  const catMap = new Map();
  for (const e of errors) {
    if (!catMap.has(e.category)) {
      catMap.set(e.category, {
        category: e.category,
        label: e.label,
        owner: e.owner,
        occurrences: 0,
        adBreaks: new Set(),
        assets: new Set(),
        hosts: {},
        sample: e.error || e.message,
      });
    }
    const c = catMap.get(e.category);
    c.occurrences++;
    if (e.adBreakId) c.adBreaks.add(e.adBreakId);
    if (e.assetId) c.assets.add(e.assetId);
    if (e.trackerHost) bump(c.hosts, e.trackerHost);
  }
  const byCategory = [...catMap.values()]
    .map((c) => ({
      category: c.category,
      label: c.label,
      owner: c.owner,
      occurrences: c.occurrences,
      adBreaks: c.adBreaks.size,
      assets: c.assets.size,
      topHosts: Object.entries(c.hosts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([host, count]) => ({ host, count })),
      sample: c.sample,
    }))
    .sort((a, b) => b.occurrences - a.occurrences);

  /* ── By tracker host (which beacon endpoint is failing) ── */
  const hostMap = new Map();
  for (const e of errors) {
    const host = e.trackerHost || "(no tracker URL in log)";
    if (!hostMap.has(host)) hostMap.set(host, { host, occurrences: 0, categories: {}, statuses: {} });
    const h = hostMap.get(host);
    h.occurrences++;
    bump(h.categories, e.category);
    if (e.httpStatus) bump(h.statuses, e.httpStatus);
  }
  const byHost = [...hostMap.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, topN);

  /* ── By asset (which creatives lose impressions) ── */
  const assetMap = new Map();
  for (const e of errors) {
    if (!e.assetId) continue;
    if (!assetMap.has(e.assetId)) assetMap.set(e.assetId, { assetId: e.assetId, occurrences: 0, categories: {}, adBreaks: new Set() });
    const a = assetMap.get(e.assetId);
    a.occurrences++;
    bump(a.categories, e.category);
    if (e.adBreakId) a.adBreaks.add(e.adBreakId);
  }
  const byAsset = [...assetMap.values()]
    .map((a) => ({ assetId: a.assetId, occurrences: a.occurrences, categories: a.categories, adBreaks: a.adBreaks.size }))
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, topN);

  /* ── Unclassified signatures ── */
  const sigMap = new Map();
  for (const e of errors.filter((x) => x.category === "UNCLASSIFIED")) {
    const sig = messageSignature({ msg: e.message, err: e.error });
    if (!sigMap.has(sig)) sigMap.set(sig, { signature: sig, count: 0, sample: e.error || e.message });
    sigMap.get(sig).count++;
  }

  const affectedAdBreakIds = [...new Set(errors.map((e) => e.adBreakId).filter(Boolean))];

  const byBreak = {};
  for (const e of errors) {
    if (!e.adBreakId) continue;
    const b = (byBreak[e.adBreakId] ||= { errors: 0, categories: {}, assets: new Set() });
    b.errors++;
    bump(b.categories, e.category);
    if (e.assetId) b.assets.add(e.assetId);
  }

  return {
    totalErrors: errors.length,
    byCategory,
    byOwner: errors.reduce((acc, e) => (bump(acc, e.owner), acc), {}),
    byHost,
    byAsset,
    unclassifiedErrors: errors.filter((e) => e.category === "UNCLASSIFIED").length,
    unclassifiedSignatures: [...sigMap.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    affectedAdBreakIds,
    affectedAdBreaks: affectedAdBreakIds.length,
    labels: Object.fromEntries(Object.entries(ruleByCategory).map(([k, r]) => [k, r.label])),
    _byBreak: byBreak,
  };
}
