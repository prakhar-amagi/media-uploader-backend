import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { getPromos, putPromos } from "../stormforge.js";
import Channel from "../models/Channel.js";

const router = express.Router();
router.use(requireAuth);

/* GET PROMOS */
router.get("/", async (req, res) => {
  try {
    const { channelName, platforms } = req.query;

    if (!channelName || !platforms) {
      return res.status(400).json({ error: "channelName & platforms required" });
    }

    const platformList = JSON.parse(platforms);

    const channel = await Channel.findOne({ channel: channelName });
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    const result = {};

    for (const platform of platformList) {
      const channelId = channel.platforms.get(platform);

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
    console.error("Promo fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* DELETE PROMO */
router.delete("/", async (req, res) => {
  try {
    const { channelName, platforms, url } = req.body;

    if (!channelName || !platforms || !url) {
      return res.status(400).json({ error: "channelName, platforms & url required" });
    }

    const channel = await Channel.findOne({ channel: channelName });
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    for (const platform of platforms) {
      const channelId = channel.platforms.get(platform);
      if (!channelId) continue;

      const data = await getPromos(channelId);

      if (!data?.ssai_configuration?.filler_config) continue;

      const urls = data.ssai_configuration.filler_config.url || [];

      data.ssai_configuration.filler_config.url =
        urls.filter(u => u !== url);

      await putPromos(channelId, data);
    }

    res.json({ success: true });

  } catch (err) {
    console.error("Delete promo error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
