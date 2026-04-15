import { requireAuth } from "../middleware/authMiddleware.js";
import express from "express";
import { getPromos, putPromos } from "../stormforge.js";
import { resolveChannelIds } from "../utils/channelMap.js";

const router = express.Router();
router.use(requireAuth);

/**
 * GET /promos?channelName=...
 * UI-safe: only returns promo URLs
 */
router.get("/", async (req, res) => {
  try {
    const { channelName, platforms } = req.query;
    if (!channelName || !platforms) {
      return res.status(400).json({ error: "channelName & platforms required" });
    }

    const platformList = JSON.parse(platforms);
    const channel = channelName;

    const result = {};

    for (const platform of platformList) {
      const channelIds = resolveChannelIds(channel, [platform]);
      const channelId = channelIds[0];

      if (!channelId) {
        result[platform] = [];
        continue;
      }

      const data = await getPromos(channelId);
      const urls =
        data?.ssai_configuration?.filler_config?.url || [];

      result[platform] = urls;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /promos
 * Removes a single promo URL
 */
router.delete("/", async (req, res) => {
  try {
    const { channelName, platforms, url } = req.body;

    if (!channelName || !platforms || !url) {
      return res.status(400).json({ error: "channelName, platforms & url required" });
    }

    const platformList = platforms;
    const channelIds = resolveChannelIds(channelName, platformList);

    for (const channelId of channelIds) {
      const data = await getPromos(channelId);
      if (!data.ssai_configuration) continue;
      if (!data.ssai_configuration.filler_config) continue;
      const urls = data.ssai_configuration.filler_config.url || [];
      data.ssai_configuration.filler_config.url =
        urls.filter(u => u !== url);
      await putPromos(channelId, data);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
