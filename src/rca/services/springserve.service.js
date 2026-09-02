import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const BASE_URL =
  process.env.SPRINGSERVE_BASE_URL ||
  "https://console.adserve.amagi.com";

let cachedToken = null;
let cachedBearerToken = null;
let tokenExpiration = 0;

/* =========================================================
   AUTHENTICATION
   ========================================================= */

async function authenticate() {
  try {
    const response = await axios.post(
      `${BASE_URL}/api/v1/auth`,
      new URLSearchParams({
        email: process.env.SPRINGSERVE_USERNAME,
        password: process.env.SPRINGSERVE_PASSWORD,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      }
    );

    if (!response.data?.token) {
      throw new Error("SpringServe did not return an API token");
    }

    cachedToken = response.data.token;
    cachedBearerToken = response.data.bearer_token || null;

    tokenExpiration = response.data.bearer_token_expiration
      ? new Date(response.data.bearer_token_expiration).getTime()
      : response.data.expiration
        ? new Date(response.data.expiration).getTime()
        : Date.now() + 5 * 60 * 60 * 1000;

    return {
      token: cachedToken,
      bearerToken: cachedBearerToken,
    };
  } catch (error) {
    console.error(
      "SpringServe authentication failed:",
      error.response?.data || error.message
    );

    throw new Error(
      error.response?.data?.error ||
      "SpringServe authentication failed"
    );
  }
}

/* =========================================================
   V0 TOKEN
   Authorization: <token>
   ========================================================= */

export async function getToken() {
  const safetyWindow = 60 * 1000;

  if (
    cachedToken &&
    Date.now() < tokenExpiration - safetyWindow
  ) {
    return cachedToken;
  }

  const auth = await authenticate();

  return auth.token;
}

/* =========================================================
   V1 BEARER TOKEN
   Authorization: Bearer <token>
   ========================================================= */

export async function getBearerToken() {
  const safetyWindow = 60 * 1000;

  if (
    cachedBearerToken &&
    Date.now() < tokenExpiration - safetyWindow
  ) {
    return cachedBearerToken;
  }

  const auth = await authenticate();

  if (!auth.bearerToken) {
    throw new Error(
      "SpringServe did not return a bearer token"
    );
  }

  return auth.bearerToken;
}

/* =========================================================
   VERIFY V1 AUTHENTICATION
   ========================================================= */

export async function verifySpringServeAuth() {
  const token = await getBearerToken();

  const response = await axios.get(
    `${BASE_URL}/api/v1/accounts/current`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return response.data;
}

/* =========================================================
   V0
   GET SUPPLY ROUTER
   ========================================================= */

export async function getSupplyRouterTopology(supplyRouterId) {
  if (!supplyRouterId) {
    throw new Error("supplyRouterId is required");
  }

  const token = await getToken();

  try {
    const response = await axios.get(
      `${BASE_URL}/api/v0/supply_routers/${supplyRouterId}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: token,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      `SpringServe supply router ${supplyRouterId} failed:`,
      error.response?.data || error.message
    );

    throw new Error(
      error.response?.data?.error ||
      `Failed to retrieve supply router ${supplyRouterId}`
    );
  }
}

/* =========================================================
   V0
   GET SUPPLY TAG
   ========================================================= */

export async function getSupplyTag(supplyTagId) {
  if (!supplyTagId) {
    throw new Error("supplyTagId is required");
  }

  const token = await getToken();

  try {
    const response = await axios.get(
      `${BASE_URL}/api/v0/supply_tags/${supplyTagId}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: token,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      `SpringServe supply tag ${supplyTagId} failed:`,
      error.response?.data || error.message
    );

    throw new Error(
      error.response?.data?.error ||
      `Failed to retrieve supply tag ${supplyTagId}`
    );
  }
}

/* =========================================================
   V0
   GET DEMAND TAG
   ========================================================= */

export async function getDemandTag(demandTagId) {
  if (!demandTagId) {
    throw new Error("demandTagId is required");
  }

  const token = await getToken();

  try {
    const response = await axios.get(
      `${BASE_URL}/api/v0/demand_tags/${demandTagId}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: token,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      `SpringServe demand tag ${demandTagId} failed:`,
      error.response?.data || error.message
    );

    throw new Error(
      error.response?.data?.error ||
      `Failed to retrieve demand tag ${demandTagId}`
    );
  }
}

/* =========================================================
   V1
   GET DEMAND TAG QUICKSTATS
   ========================================================= */

export async function getDemandTagQuickStats(
  demandTagId,
  dateRange = "Last 30 Days"
) {
  if (!demandTagId) {
    throw new Error("demandTagId is required");
  }

  const token = await getBearerToken();

  try {
    const response = await axios.get(
      `${BASE_URL}/api/v1/demand_tags/${demandTagId}`,
      {
        params: {
          additional_data: "quickstats",
          date_range: dateRange,
        },
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      `SpringServe demand tag quickstats ${demandTagId} failed:`,
      error.response?.data || error.message
    );

    throw new Error(
      error.response?.data?.error ||
      `Failed to retrieve demand tag ${demandTagId} quickstats`
    );
  }
}

/* =========================================================
   Day-wise tag performance — /api/v1/dashboards/tag_performance

   Unlike quickstats (current_value/past_value aggregates only),
   this gives real per-day rows. Response shape is NOT documented
   in the swagger (just declared "type: object"), so this returns
   the raw response untouched for now — normalize once we've seen
   a real sample and know the actual field names/structure.
   ========================================================= */
export async function getDemandTagPerformance(
  demandTagId,
  { dateRange = "Last 30 Days", interval = "day", tagType = "demand" } = {}
) {
  if (!demandTagId) {
    throw new Error("demandTagId is required");
  }

  const token = await getBearerToken();

  try {
    const response = await axios.get(
      `${BASE_URL}/api/v1/dashboards/tag_performance`,
      {
        params: {
          date_range: dateRange,
          interval,
          tag_type: tagType,
          id: demandTagId,
        },
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      `SpringServe tag_performance for ${demandTagId} failed:`,
      error.response?.data || error.message
    );

    throw new Error(
      error.response?.data?.error ||
      `Failed to retrieve tag performance for demand tag ${demandTagId}`
    );
  }
}