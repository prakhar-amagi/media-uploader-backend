export function buildAdAnalyticsQuery({
  database,
  channelId,
  startDate,
  endDate
}) {

  return `
SELECT

    date_format(
        TRY_CAST(detected_timestamp AS timestamp),
        '%Y-%m-%d'
    ) AS ts,


    count(ad_break_id) AS detections,


    sum(
        TRY_CAST(duration AS double)
    ) AS duration,


    sum(
        TRY_CAST(total_request AS bigint)
    ) AS requests,


    sum(
        TRY_CAST(empty_response AS bigint)
    ) AS empty,


    sum(
        TRY_CAST(error_response AS bigint)
    ) AS errors,


    sum(
        TRY_CAST(ads_received AS bigint)
    ) AS total_ads,


    sum(
        TRY_CAST(ads_not_transcoded AS bigint)
    ) AS non_transcoded,


    sum(
        TRY_CAST(ads_overflow AS bigint)
    ) AS overflow,


    sum(
        TRY_CAST(repeated_ads AS bigint)
    ) AS repeated,


    sum(
        TRY_CAST(ads_usable AS bigint)
    ) AS usable_ads,


    sum(
        TRY_CAST(impressions AS bigint)
    ) AS impressions,


    sum(
        TRY_CAST(quartile_25_fired AS bigint)
    ) AS q25,


    sum(
        TRY_CAST(quartile_50_fired AS bigint)
    ) AS q50,


    sum(
        TRY_CAST(quartile_75_fired AS bigint)
    ) AS q75,


    sum(
        TRY_CAST(quartile_100_fired AS bigint)
    ) AS q100,


    ROUND(

        (
            sum(
                TRY_CAST(impressions AS double)
            )

            /

            NULLIF(
                sum(
                    TRY_CAST(ads_usable AS double)
                ),
                0
            )
        ) * 100

    ) AS conversion


FROM ${database}.hourly_agg_ad_analytics


WHERE

    TRY_CAST(
        detected_timestamp AS timestamp
    ) >= TIMESTAMP '${startDate}'


    AND


    TRY_CAST(
        detected_timestamp AS timestamp
    ) < TIMESTAMP '${endDate}'


    AND channel_id = '${channelId}'


GROUP BY 1

ORDER BY 1

LIMIT 10000
`;
}
