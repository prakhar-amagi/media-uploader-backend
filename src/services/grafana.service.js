import axios from "axios";

/* ─── Setup → Grafana cluster mapping ─────────────────────────────────────── */
const CLUSTERS = {
  use2n1: "grafana.ue2-n1.tsv3.amagi.tv",
  use2n2: "grafana.ue2-n2.tsv3.amagi.tv",
  aps1:   "grafana.apse1.tsv3.amagi.tv",
  eun2:   "grafana.ew1-n2.tsv3.amagi.tv",
  usw2n1: "grafana.uw2-n1.tsv3.amagi.tv",
  usw2n2: "grafana.uw2-n2.tsv3.amagi.tv",
};

const SETUP_TO_CLUSTER = {
  "ts-us-e2-n1": "use2n1",
  "ts-us-e2-n2": "use2n2",
  "ts-us-w2-n1": "usw2n1",
  "ts-us-w2-n2": "usw2n2",
  "ts-eu-w1-n2": "eun2",
  "ts-ap-s1-n1": "aps1",
};

const DASHBOARD_UID = "x8yElCH7k";

/* ─── Token resolution ─────────────────────────────────────────────────────── */
function getToken(clusterKey) {
  const specific = process.env[`GRAFANA_TOKEN_${clusterKey.toUpperCase()}`];
  if (specific) return specific;
  const shared = process.env.GRAFANA_TOKEN;
  if (shared) return shared;
  return null;
}

function authHeaders(clusterKey) {
  const token = getToken(clusterKey);
  if (!token) throw new Error(`No Grafana token configured for cluster '${clusterKey}'. Set GRAFANA_TOKEN_${clusterKey.toUpperCase()} or GRAFANA_TOKEN in .env`);
  return { Authorization: `Bearer ${token}` };
}

/* ─── Datasource UID cache (auto-discovered from dashboard JSON) ───────────── */
const _dsCache = {};

async function discoverDatasourceUid(host, clusterKey) {
  if (_dsCache[host]) return _dsCache[host];

  const res = await axios.get(
    `https://${host}/api/dashboards/uid/${DASHBOARD_UID}`,
    { headers: authHeaders(clusterKey), timeout: 15000 }
  );

  let uid = null;
  for (const panel of res.data?.dashboard?.panels || []) {
    const ds = panel.datasource;
    if (ds?.uid) { uid = ds.uid; break; }
    for (const t of panel.targets || []) {
      if (t.datasource?.uid) { uid = t.datasource.uid; break; }
    }
    if (uid) break;
  }

  if (!uid) throw new Error(`Could not discover datasource UID from dashboard ${DASHBOARD_UID} on ${host}`);
  _dsCache[host] = uid;
  return uid;
}

/* ─── Core range query ─────────────────────────────────────────────────────── */
export async function queryRange({ setup, promql, days = 7, stepSeconds = 60 }) {
  const clusterKey = SETUP_TO_CLUSTER[setup];
  if (!clusterKey) throw new Error(`Unknown setup '${setup}'`);

  const host = CLUSTERS[clusterKey];
  const dsUid = await discoverDatasourceUid(host, clusterKey);

  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;

  const res = await axios.get(
    `https://${host}/api/datasources/proxy/uid/${dsUid}/api/v1/query_range`,
    {
      headers: authHeaders(clusterKey),
      params: { query: promql, start, end, step: `${stepSeconds}s` },
      timeout: 30000,
    }
  );

  if (res.data?.status !== "success") {
    throw new Error(`Grafana query failed for setup=${setup}: ${JSON.stringify(res.data)}`);
  }

  return res.data.data.result; // [{metric:{...}, values:[[ts,"val"],...]}]
}

/* ─── Token verify (hits /api/org — same as Grafana admin curl example) ────── */
export async function verifyToken(clusterKey) {
  const host = CLUSTERS[clusterKey];
  if (!host) return { ok: false, error: `Unknown cluster '${clusterKey}'` };

  const token = getToken(clusterKey);
  if (!token) return { ok: false, error: "Token not configured" };

  try {
    const res = await axios.get(`https://${host}/api/org`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return { ok: true, org: res.data };
  } catch (err) {
    const status = err.response?.status;
    return { ok: false, error: status ? `HTTP ${status} — token rejected` : err.message };
  }
}

export { CLUSTERS, SETUP_TO_CLUSTER, getToken };
