import axios from "axios";

const client = axios.create({
  baseURL: "https://stormforge.tsv3.amagi.tv/v1/tsdelivery",
  headers: {
    // Reuses the same STORMFORGE_BEARER env var the existing app already uses
    Authorization: `Bearer ${process.env.STORMFORGE_BEARER}`,
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

export async function getDeliveryConfig(channelId) {
  const res = await client.get(`/${channelId}`);
  return res.data;
}

export function extractClusterSplits(config) {
  const productsSplit = config?.egress_properties?.products_split;

  if (!productsSplit?.enabled) {
    // No split config — fall back to the single active setup
    const setup = config?.setup;
    return setup ? [{ setup, splitPct: 100, product: "ts" }] : [];
  }

  const splits = [];
  for (const productCfg of productsSplit.product_split_cfg_list || []) {
    for (const cluster of productCfg.cluster_split || []) {
      splits.push({
        setup: cluster.cluster,
        splitPct: cluster.split,
        product: productCfg.product || "ts",
      });
    }
  }
  return splits;
}

export async function getChannelSummary(channelId) {
  const config = await getDeliveryConfig(channelId);
  return {
    channelId,
    deliveryName: config.delivery_name,
    customerName: config.customer_name,
    primarySetup: config.setup,
    splits: extractClusterSplits(config),
  };
}
