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
  const primarySetup = config?.setup; // Lifted up for use in both branches

  if (!productsSplit?.enabled) {
    // No product-split config — resolve the single active setup, but
    // first check whether traffic is currently being redirected to a
    // backup cluster (egress_properties.backup.redirect_enabled).
    const backupCfg = config?.egress_properties?.backup;
    const backupSetup =
      config?.backup_clusters?.find((c) => c.is_backup)?.setup ||
      config?.backup_clusters?.[0]?.setup ||
      null;

    if (backupCfg?.redirect_enabled && backupSetup) {
      const bypassPct = Number(backupCfg.bypassPercentage ?? 100);

      if (bypassPct >= 100) {
        // All traffic redirected to backup
        return [{ setup: backupSetup, splitPct: 100, product: "ts", isBackup: true }];
      }

      if (bypassPct > 0) {
        // Partial bypass — traffic is split between primary and backup.
        const splits = [{ setup: backupSetup, splitPct: bypassPct, product: "ts", isBackup: true }];
        if (primarySetup) {
          splits.push({ setup: primarySetup, splitPct: 100 - bypassPct, product: "ts", isBackup: false });
        }
        return splits;
      }
    }

    return primarySetup ? [{ setup: primarySetup, splitPct: 100, product: "ts", isBackup: false }] : [];
  }

  // Handle products_split when enabled
  const splits = [];
  for (const productCfg of productsSplit.product_split_cfg_list || []) {
    
    // If cluster_split exists, map those out
    if (productCfg.cluster_split && productCfg.cluster_split.length > 0) {
      for (const cluster of productCfg.cluster_split) {
        splits.push({
          setup: cluster.cluster,
          splitPct: cluster.split,
          product: productCfg.product || "ts",
          isBackup: false
        });
      }
    } else if (primarySetup) {
      // If no cluster_split is defined, traffic for this product goes to the primary setup
      splits.push({
        setup: primarySetup,
        splitPct: productCfg.split || 100, // Use the product's split percentage
        product: productCfg.product || "ts",
        isBackup: false
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