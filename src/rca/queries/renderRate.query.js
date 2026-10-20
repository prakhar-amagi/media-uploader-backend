/* =========================================================
   Render-rate RCA — Athena query builders.

   Three queries, one per render-rate factor:
     1. Rule Engine errors  (ad assets not transcoded)
     2. User drop after ad fetch (prefetcher ActiveUsers vs.
        AdOpportunitiesDetected)
     3. Tracker errors       (invalid / unfired trackers)

   All builders take the cluster's Athena `database` so the
   same query runs against whichever cluster(s) the channel
   is split across (resolved from StormForge, see
   athenaDetectionTrend.service.js#resolveAthenaClusterKey).

   Tables are partitioned by year/month/day/hour (integers),
   so every query filters partitions first, then narrows by
   ts inside the partition.
   ========================================================= */

const HOUR_MS = 60 * 60 * 1000;

export function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

/** "2026-10-03T10:00:00" (no millis, no Z) — matches the log ts string format. */
function toTsString(date) {
  return date.toISOString().slice(0, 19);
}

/** "2026-10-03T10:00:00.000Z" — for from_iso8601_timestamp(). */
function toIsoString(date) {
  return date.toISOString();
}

/**
 * Build the UTC window for a date (YYYY-MM-DD) + hour (0-23).
 */
export function buildTimeWindow(date, hour) {
  const start = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid date/hour: ${date} ${hour}`);
  }
  const end = new Date(start.getTime() + HOUR_MS);
  return { start, end };
}

/**
 * Partition predicate covering every hour touched by [start, end).
 * Handles day/month/year boundaries, e.g. 23:50 -> 00:15 next day
 * becomes:
 *   ((year = 2026 AND month = 10 AND day = 3 AND hour IN (23))
 *    OR (year = 2026 AND month = 10 AND day = 4 AND hour IN (0)))
 */
export function buildPartitionFilter(start, end) {
  const byDay = new Map();

  // Walk hour-by-hour from the hour containing `start`
  const cursor = new Date(start);
  cursor.setUTCMinutes(0, 0, 0);

  while (cursor < end) {
    const key = `${cursor.getUTCFullYear()}-${cursor.getUTCMonth() + 1}-${cursor.getUTCDate()}`;
    if (!byDay.has(key)) {
      byDay.set(key, {
        year: cursor.getUTCFullYear(),
        month: cursor.getUTCMonth() + 1,
        day: cursor.getUTCDate(),
        hours: [],
      });
    }
    byDay.get(key).hours.push(cursor.getUTCHours());
    cursor.setTime(cursor.getTime() + HOUR_MS);
  }

  const clauses = [...byDay.values()].map(
    (d) => `(year = ${d.year} AND month = ${d.month} AND day = ${d.day} AND hour IN (${d.hours.join(", ")}))`
  );

  return clauses.length === 1 ? clauses[0] : `(${clauses.join("\n    OR ")})`;
}

/* ─── 1. Rule Engine errors ───────────────────────────────────────────── */

export function buildRuleEngineErrorsQuery({ database, channelId, start, end, limit = 10000 }) {
  return `
SELECT
  ts,
  level,
  msg,
  caller,
  channel_id,
  user_id,
  request_id,
  ad_break_id,
  meta,
  err,
  reason,
  stacktrace,
  kubernetes.pod_name AS pod_name
FROM ${database}.core_rule_engine
WHERE ${buildPartitionFilter(start, end)}
  AND ts >= '${toTsString(start)}'
  AND ts < '${toTsString(end)}'
  AND channel_id = '${escapeSql(channelId)}'
  AND level = 'error'
ORDER BY ts
LIMIT ${Number(limit)}
`;
}

/* ─── 2. User drop after ad fetch ─────────────────────────────────────── */

/**
 * For every ad break whose FIRST AdOpportunitiesDetected event falls
 * inside [start, end), compare:
 *   - the latest ActiveUsers snapshot at/before the opportunity, with
 *   - the first ActiveUsers snapshot at/after (opportunity + duration).
 *
 * ActiveUsers is read from a wider window (lookback/lookahead) so a
 * break at 10:59:50 lasting 120s can still find its "after" snapshot
 * in hour 11, and a break at 10:00:05 can find its "before" snapshot
 * in hour 9. Partitions are expanded automatically.
 */
export function buildUserDropQuery({
  database,
  channelId,
  start,
  end,
  lookbackMinutes = 15,
  lookaheadMinutes = 15,
}) {
  const wideStart = new Date(start.getTime() - lookbackMinutes * 60 * 1000);
  const wideEnd = new Date(end.getTime() + lookaheadMinutes * 60 * 1000);
  const ch = escapeSql(channelId);

  return `
WITH active_users AS (
  SELECT
    from_iso8601_timestamp(ts) AS event_time,
    channel_id,
    TRY_CAST(json_extract_scalar(meta, '$.count') AS INTEGER) AS active_users
  FROM ${database}.analytics_prefetcher
  WHERE ${buildPartitionFilter(wideStart, wideEnd)}
    AND channel_id = '${ch}'
    AND msg = 'ActiveUsers'
    AND from_iso8601_timestamp(ts) >= from_iso8601_timestamp('${toIsoString(wideStart)}')
    AND from_iso8601_timestamp(ts) <  from_iso8601_timestamp('${toIsoString(wideEnd)}')
),

ad_opportunities_raw AS (
  SELECT
    from_iso8601_timestamp(ts) AS opportunity_time,
    channel_id,
    ad_break_id,
    segment_id,
    TRY_CAST(json_extract_scalar(meta, '$.count') AS INTEGER) AS ad_opportunities,
    COALESCE(TRY_CAST(json_extract_scalar(meta, '$.duration') AS INTEGER), 0) AS duration_seconds,
    break_type
  FROM ${database}.analytics_prefetcher
  WHERE ${buildPartitionFilter(start, end)}
    AND channel_id = '${ch}'
    AND msg = 'AdOpportunitiesDetected'
    AND from_iso8601_timestamp(ts) >= from_iso8601_timestamp('${toIsoString(start)}')
    AND from_iso8601_timestamp(ts) <  from_iso8601_timestamp('${toIsoString(end)}')
),

/* First opportunity event for each ad break */
first_opportunity_ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY ad_break_id ORDER BY opportunity_time) AS break_rn
  FROM ad_opportunities_raw
),

first_opportunity_per_break AS (
  SELECT opportunity_time, channel_id, ad_break_id, segment_id,
         ad_opportunities, duration_seconds, break_type
  FROM first_opportunity_ranked
  WHERE break_rn = 1
),

/* Latest ActiveUsers snapshot at/before each break */
users_before_ranked AS (
  SELECT
    a.*,
    u.event_time   AS active_users_before_time,
    u.active_users AS active_users_before,
    ROW_NUMBER() OVER (PARTITION BY a.ad_break_id ORDER BY u.event_time DESC) AS before_rn
  FROM first_opportunity_per_break a
  LEFT JOIN active_users u
    ON u.channel_id = a.channel_id
   AND u.event_time <= a.opportunity_time
),

users_before AS (
  SELECT * FROM users_before_ranked WHERE before_rn = 1
),

/* First ActiveUsers snapshot at/after the full ad-break duration */
users_after_ranked AS (
  SELECT
    a.ad_break_id,
    u.event_time   AS active_users_after_time,
    u.active_users AS active_users_after,
    ROW_NUMBER() OVER (PARTITION BY a.ad_break_id ORDER BY u.event_time ASC) AS after_rn
  FROM first_opportunity_per_break a
  LEFT JOIN active_users u
    ON u.channel_id = a.channel_id
   AND u.event_time >= a.opportunity_time + INTERVAL '1' SECOND * a.duration_seconds
),

users_after AS (
  SELECT * FROM users_after_ranked WHERE after_rn = 1
)

SELECT
  b.opportunity_time,
  b.channel_id,
  b.ad_break_id,
  b.segment_id,
  b.ad_opportunities,
  b.duration_seconds,
  b.break_type,
  b.active_users_before_time,
  b.active_users_before,
  b.opportunity_time + INTERVAL '1' SECOND * b.duration_seconds AS expected_after_time,
  a.active_users_after_time,
  a.active_users_after,
  date_diff('second', b.opportunity_time, a.active_users_after_time) AS actual_seconds_after_opportunity,
  b.active_users_before - a.active_users_after AS user_drop,
  ROUND(
    100.0 * (b.active_users_before - a.active_users_after)
    / NULLIF(b.active_users_before, 0),
    2
  ) AS user_drop_percentage
FROM users_before b
LEFT JOIN users_after a ON b.ad_break_id = a.ad_break_id
ORDER BY b.opportunity_time
`;
}

/* ─── 3. Tracker errors ───────────────────────────────────────────────── */

export function buildTrackerErrorsQuery({ database, channelId, start, end, limit = 10000 }) {
  return `
SELECT
  ts,
  level,
  msg,
  caller,
  channel_id,
  user_id,
  ad_break_id,
  segment_id,
  asset_id,
  request_id,
  ad_url,
  meta,
  err,
  reason,
  stacktrace,
  kubernetes.pod_name AS pod_name
FROM ${database}.core_tracker
WHERE ${buildPartitionFilter(start, end)}
  AND ts >= '${toTsString(start)}'
  AND ts < '${toTsString(end)}'
  AND channel_id = '${escapeSql(channelId)}'
  AND level = 'error'
ORDER BY ts
LIMIT ${Number(limit)}
`;
}

/**
 * How old the requested window is, measured both ways the validator might
 * measure it: calendar days (today − date) and whole days elapsed since the
 * earliest data the queries touch (window start minus the ActiveUsers
 * lookback). Returns the larger, so we never send a query it will cancel.
 */
export function dataAgeDays({ date, hour, lookbackMinutes = 0, now = new Date() }) {
  const { start } = buildTimeWindow(date, hour);
  const earliest = new Date(start.getTime() - lookbackMinutes * 60 * 1000);

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const calendarDays = Math.round((today - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  const elapsedDays = Math.floor((now.getTime() - earliest.getTime()) / 86400000);

  return Math.max(calendarDays, elapsedDays);
}

/** Oldest date (YYYY-MM-DD, UTC) that is fully inside the allowed age. */
export function oldestAllowedDate(maxAgeDays, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - maxAgeDays * 86400000);
  return d.toISOString().slice(0, 10);
}
