import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import { getPromos, putPromos } from "../stormforge.js";
import Channel from "../models/Channel.js";
import Log from "../models/Log.js";

const router = express.Router();
router.use(requireAuth);

/* ---------------- GET PROMOS ---------------- */
router.get("/", async (req, res) => {
  try {
    const { channelName, platforms } = req.query;

    if (!channelName || !platforms) {
      return res.status(400).json({
        error: "channelName & platforms required"
      });
    }

    const platformList = JSON.parse(platforms);

    const channel = await Channel.findOne({ channel: channelName });

    if (!channel) {
      return res.status(404).json({
        error: "Channel not found"
      });
    }

    const result = {};

    for (const platform of platformList) {
      const channelId = channel.platforms[platform];

      if (!channelId) {
        result[platform] = [];
        continue;
      }

      const data = await getPromos(channelId);

      result[platform] =
        data?.ssai_configuration?.filler_config?.url || [];
    }

    res.json(result);

  } catch (err) {
    console.error("❌ Promo fetch error:", err);
    res.status(500).json({
      error: err.message
    });
  }
});


/* ---------------- DELETE PROMO(S) ---------------- */
router.delete("/", async (req, res) => {

  try {

    const { channelName, platforms, url, urls } = req.body;

    const deleteUrls = urls || (url ? [url] : []);

    if (
      !channelName ||
      !platforms ||
      deleteUrls.length === 0
    ) {
      return res.status(400).json({
        error: "channelName, platforms & url(s) required"
      });
    }

    const channel = await Channel.findOne({
      channel: channelName
    });

    if (!channel) {
      return res.status(404).json({
        error: "Channel not found"
      });
    }

    for (const platform of platforms) {

      const channelId = channel.platforms[platform];

      if (!channelId) {
        console.log(`No channelId for ${platform}`);
        continue;
      }

      let data = await getPromos(channelId);

      if (!data?.ssai_configuration?.filler_config) {
        console.log(`No filler config for ${platform}`);
        continue;
      }

      const existingUrls =
        data.ssai_configuration.filler_config.url || [];

      const beforeCount = existingUrls.length;

      const updatedUrls = existingUrls.filter(
        u => !deleteUrls.includes(u)
      );

      const removedCount =
        beforeCount - updatedUrls.length;

      // Nothing changed
      if (removedCount === 0) {
        console.log(`No matching promos found for ${platform}`);
        continue;
      }

      data.ssai_configuration.filler_config.url =
        updatedUrls;

      await putPromos(channelId, data);

      console.log(
        `🗑 Removed ${removedCount} promo(s) from ${platform}`
      );

      await Log.create({
        action: "DELETE_PROMOS",
        userEmail: req.user.email,
        channel: channelName,
        platform,
        channelId,
        details: {
          deleted: deleteUrls,
          removedCount,
          beforeCount,
          afterCount: updatedUrls.length
        }
      });

    }

    res.json({
      success: true,
      deleted: deleteUrls.length
    });

  } catch (err) {

    console.error("❌ Delete promo error:", err);

    res.status(500).json({
      error: err.message
    });

  }

});

export default router;