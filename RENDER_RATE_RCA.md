# Render Rate RCA

Answers "why did render rate drop for channel X at hour H (UTC)?" by checking the three factors that stop a fetched ad from producing an impression:

1. **Ad assets not transcoded** — `core_rule_engine` errors (VPAID, no audio, URL inaccessible, invalid asset, max transcode attempts).
2. **Users dropped after ad fetch** — `analytics_prefetcher` ActiveUsers before the break vs. after the break's duration.
3. **Tracker invalid / not fired** — `core_tracker` errors.

UI: `/render-rate-rca.html` (linked from the app menu and the Impression RCA page).

## How it plugs into the existing app

| Reused | How |
|---|---|
| `rca/services/athenaClient.service.js` | Same `runAthenaQuery` + `thunderstorm-v3` SSO profile. Now paginates results (was capped at the first 1000 rows). Existing callers are unaffected. |
| `rca/clusters.js` + `resolveAthenaClusterKey` | Database per cluster. The PDF queries hard-coded `ts_eu_w1_n2`; the engine now runs against whichever cluster(s) the channel is split across. |
| `getChannelSummary` (StormForge) | Resolves cluster splits automatically. A manual cluster override is available in the UI / API. |
| `/rca/aws-sso/*` | The same AWS connect gate as Impression RCA. |
| `requireAuth`, Mongo | The route is mounted inside the RCA router, so auth is inherited; runs are saved to `RenderRateInvestigation`. |

## Files

```
src/rca/
  renderRate.routes.js                 POST /rca/render-rate/analyze, history, clusters
  services/renderRateRca.service.js    orchestrator: clusters → 3×N queries → analyzers → verdict
  queries/renderRate.query.js          the three SQL builders + partition helpers
  models/RenderRateInvestigation.js
  rules/renderRate/
    classifiers.js                     ← all log-wording patterns live here
    config.js                          thresholds (env-overridable)
    ruleEngineAnalyzer.js
    userDropAnalyzer.js
    trackerAnalyzer.js
    verdict.js                         correlation, evidence levels, verdict, text report
public/render-rate-rca.html
```

## API

```
POST /rca/render-rate/analyze
{ "channelId": "amg01076-lightning-concerto-philipstvemea", "date": "2026-10-03", "hour": 10,
  "clusterKeys": ["eun2"] }          // optional; default = resolved from StormForge
```

Returns `verdict`, `ruleEngine`, `userDrop`, `tracker`, `correlation`, `queryStatus`, `diagnostics` (including the SQL that ran), and `report`, a plain-text RCA ready to paste into a ticket.

`GET /rca/render-rate/history?channelId=&limit=` · `GET /rca/render-rate/history/:id` · `GET /rca/render-rate/clusters`

## Changes from the PDF queries

- **User-drop "after" snapshot uses `+ duration`.** The PDF's `opportunity_time – INTERVAL … * duration` is an en-dash, which is a SQL syntax error. Its comment, "first ActiveUsers snapshot after the full ad-break duration", means `+`.
- **ActiveUsers partitions are padded automatically.** The window is extended 15 min before and after the hour, and the partitions are expanded across day/month boundaries. This means a break at 10:59:50 still finds its "after" snapshot in hour 11, and a break at 10:00:05 still finds its "before" snapshot in hour 9. Ad opportunities themselves are restricted to the selected hour.
- **The `/ … /` comments became `/* … */`.** The PDF had mangled the comment markers.
- **The `ts` upper bound is exclusive (`<`).** This prevents the same rows from being counted in two adjacent hours.
- **`TRY_CAST` is used on `meta` fields, and `duration` defaults to 0.** This stops a single malformed row from failing the whole query.

## Evidence levels

The tool reports one of these for each factor: `CONFIRMED` (error logs show it), `OBSERVED` (the user drop is behavioural, so it's evidence of correlation, not proof), `NOT_OBSERVED`, `INSUFFICIENT_EVIDENCE`, or `QUERY_FAILED`. A failure on one cluster doesn't fail the run. The affected numbers are marked partial and confidence is lowered.

Severity is based on the **share of the hour's ad breaks** each factor touched. The denominator is the set of breaks from `AdOpportunitiesDetected`, which makes the three factors comparable.

## Tuning — do this after the first real runs

The rule-engine and tracker categories are matched with regex patterns in `classifiers.js`. These are educated guesses until they're checked against real log wording. Any error that doesn't match shows up in the UI under **"Unclassified signatures"** with a sample. To classify it, add a pattern to the right rule; no other code changes.

Thresholds can be set in `.env`. The defaults are shown below:

```
RENDER_RCA_USER_DROP_PCT=5          # per-break drop counted as significant
RENDER_RCA_USER_DROP_HIGH_PCT=15    # hour-weighted drop that forces HIGH
RENDER_RCA_STALE_AFTER_SEC=120      # "after" snapshot later than this past break end → flagged
RENDER_RCA_LOOKBACK_MIN=15
RENDER_RCA_LOOKAHEAD_MIN=15
RENDER_RCA_ERROR_QUERY_LIMIT=10000
RENDER_RCA_COVERAGE_HIGH_PCT=30
RENDER_RCA_COVERAGE_MEDIUM_PCT=10
RENDER_RCA_MAX_CONCURRENT_QUERIES=2 # Athena queries in flight per run
RENDER_RCA_MAX_DATA_AGE_DAYS=5      # validator cancels raw-log queries ≥ 6 days old; 0 disables the check
ATHENA_WORKGROUP=                   # optional; default "primary" (applies to all Athena calls)
```

## Queries showing "CANCELLED: Query cancelled by user"

Athena only reports CANCELLED when something calls `StopQueryExecution`, and this app never does. The cause is external: a person, a script, or an account guard such as a runtime or scan-size limit. The diagnostics panel shows each query's ID, workgroup, runtime and data scanned. To find who cancelled it, look up the `StopQueryExecution` event in CloudTrail; its `userIdentity` field identifies the caller.

On this account the canceller is the `athena-query-validator-eu-west-1` Lambda, and the reason appears in its CloudWatch logs as `CANCELLED historical query … (age Nd)`. It cancels any query on raw-log data that is 6 or more days old. The tool therefore rejects older windows before sending them, using `RENDER_RCA_MAX_DATA_AGE_DAYS=5`. If the validator's policy changes, update that value.

## Known limits / next steps

- **No baseline yet.** "31 tracker errors" doesn't establish that 31 is abnormal. The next step is to run the same queries for the same hour on the previous day (or the previous N hours) and compare.
- **Silent tracker non-firing isn't detectable.** It doesn't produce an error row. Detecting it needs an expected-vs-fired query on tracker success events.
- **If ActiveUsers is emitted per pod rather than per channel**, the before/after snapshots should be summed per timestamp. Confirm this against real data.
