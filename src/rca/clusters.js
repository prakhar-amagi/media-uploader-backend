/* =========================================================
   Athena cluster -> database mapping.

   Keys here intentionally match the short cluster keys used
   by src/services/grafana.service.js's SETUP_TO_CLUSTER map,
   so a single resolved cluster key (e.g. "use2n1") can be used
   to query both Grafana and Athena for the same channel.
   ========================================================= */

export const clusters = {
  usw2n1: {
    region: "us-west-2",
    database: "ts_us_w2_n1",
    outputLocation: "s3://athena-query-us-west/",
    profile: "thunderstorm-v3",
  },

  usw2n2: {
    region: "us-west-2",
    database: "ts_us_w2_n2",
    outputLocation: "s3://athena-query-us-west/",
    profile: "thunderstorm-v3",
  },

  eun2: {
    region: "eu-west-1",
    database: "ts_eu_w1_n2",
    outputLocation: "s3://athena-query-eu-west/",
    profile: "thunderstorm-v3",
  },

  use2n1: {
    region: "us-east-2",
    database: "ts_us_e2_n1",
    outputLocation: "s3://athena-query-us-east/",
    profile: "thunderstorm-v3",
  },

  use2n2: {
    region: "us-east-2",
    database: "ts_us_e2_n2",
    outputLocation: "s3://athena-query-us-east/",
    profile: "thunderstorm-v3",
  },

  aps1: {
    region: "ap-south-1",
    database: "ts_ap_s1_n1",
    outputLocation: "s3://athena-query-ap-south-aws/",
    profile: "thunderstorm-v3",
  },
};
