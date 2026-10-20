/* =========================================================
   Render-rate RCA — tunable thresholds.
   Every value can be overridden from .env without code changes.
   ========================================================= */

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
};

export const RENDER_RCA_CONFIG = {
  /** A break counts as a meaningful user drop at/above this % */
  userDropThresholdPct: num("RENDER_RCA_USER_DROP_PCT", 5),

  /** Weighted (whole-hour) drop % at/above which the user-drop factor is HIGH */
  userDropHighPct: num("RENDER_RCA_USER_DROP_HIGH_PCT", 15),

  /** "After" snapshot later than (duration + this) seconds is flagged stale */
  staleAfterToleranceSec: num("RENDER_RCA_STALE_AFTER_SEC", 120),

  /** ActiveUsers window padding so edge-of-hour breaks have before/after snapshots */
  activeUsersLookbackMin: num("RENDER_RCA_LOOKBACK_MIN", 15),
  activeUsersLookaheadMin: num("RENDER_RCA_LOOKAHEAD_MIN", 15),

  /** Row cap per error query (Athena LIMIT) */
  errorQueryLimit: num("RENDER_RCA_ERROR_QUERY_LIMIT", 10000),

  /** Severity by share of the hour's ad breaks affected by a factor */
  coverageHighPct: num("RENDER_RCA_COVERAGE_HIGH_PCT", 30),
  coverageMediumPct: num("RENDER_RCA_COVERAGE_MEDIUM_PCT", 10),

  /** Fallback severity by raw error count when ad-break coverage is unknown */
  countHigh: num("RENDER_RCA_COUNT_HIGH", 50),
  countMedium: num("RENDER_RCA_COUNT_MEDIUM", 10),

  /**
   * The account's athena-query-validator Lambda cancels queries on raw-log
   * data older than this ("CANCELLED historical query … (age 6d)").
   * Observed: ages ≥ 6d are cancelled, so 5 days is the newest safe limit.
   * Set to 0 to disable the check.
   */
  maxDataAgeDays: num("RENDER_RCA_MAX_DATA_AGE_DAYS", 5),

  /** Max Athena queries in flight per RCA run (3 per cluster are queued) */
  maxConcurrentQueries: num("RENDER_RCA_MAX_CONCURRENT_QUERIES", 2),

  /** How many rows to return in tables to keep responses small */
  topN: num("RENDER_RCA_TOP_N", 50),
};
