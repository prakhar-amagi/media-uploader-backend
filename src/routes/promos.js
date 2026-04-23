import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { getPromos, putPromos } from "../stormforge.js";
import Channel from "../models/Channel.js";
import Log from "../models/Log.js";

const router = express.Router();
router.use(requireAuth);

/* GET PROMOS */
router.get("/", async (req, res) => {
  try {
    const { channelName, platforms } = req.query;

    const platformList = JSON.parse(platforms);
    const channel = await Channel.findOne({ channel: channelName });

    const result = {};

    for (const platform of platformList) {
      const channelId = channel.platforms[platform];

      if (!channelId) {
        result[platform] = [];
        continue;
      }

      const data = await getPromos(channelId);
      result[platform] = data?.ssai_configuration?.filler_config?.url || [];
    }

    res.json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* DELETE PROMO */
router.delete("/", async (req, res) => {
  try {
    const { channelName, platforms, url } = req.body;

    const channel = await Channel.findOne({ channel: channelName });

    for (const platform of platforms) {
      const channelId = channel.platforms[platform];
      if (!channelId) continue;

      const data = await getPromos(channelId);
      if (!data?.ssai_configuration?.filler_config) continue;

      const urls = data.ssai_configuration.filler_config.url || [];

      data.ssai_configuration.filler_config.url =
        urls.filter(u => u !== url);

      await putPromos(channelId, data);
    }

    await Log.create({
      action: "PROMO_DELETE",
      userEmail: req.user.email,
      channel: channelName,
      details: { platforms, url }
    });

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
