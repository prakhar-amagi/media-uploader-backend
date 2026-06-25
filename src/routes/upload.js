import express from "express";
import multer from "multer";
import fs from "fs";

import { requireAuth } from "../middleware/authMiddleware.js";
import { sanitizeFilename } from "../utils/filename.js";
import { uploadToS3 } from "../s3.js";
import { getPromos, putPromos } from "../stormforge.js";
import Channel from "../models/Channel.js";
import Log from "../models/Log.js";

const upload = multer({ dest: "/tmp" });
const router = express.Router();

router.use(requireAuth);

/* ---------- Ensure SSAI config ---------- */
function ensureFillerConfig(data) {
  if (!data.ssai_configuration) {
    data.ssai_configuration = {};
  }

  if (!data.ssai_configuration.filler_config) {
    data.ssai_configuration.filler_config = {
      no_replacement_mode: "fill_ad_break",
      partial_replacement_mode: "fill_ad_break",
      filler_selection_strategy: "random",
      url: []
    };
  }

  if (!Array.isArray(data.ssai_configuration.filler_config.url)) {
    data.ssai_configuration.filler_config.url = [];
  }

  return data;
}

/* ---------- UPLOAD ---------- */
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const { channelNames, platforms } = req.body;

    if (!channelNames || !platforms || !req.file) {
      return res.status(400).json({
        error: "channelNames, platforms & file required"
      });
    }

    const selectedChannels = JSON.parse(channelNames);
    const platformList = JSON.parse(platforms);

    /* ---------- Upload to S3 ---------- */
    const filename = sanitizeFilename(
      req.file.originalname
    );

    const cfUrl = await uploadToS3(
      req.file.path,
      filename
    );

    const deliveries = [];

    /* ---------- Process all channels ---------- */
    for (const channelName of selectedChannels) {

      const channel = await Channel.findOne({
        channel: channelName
      });

      if (!channel) {
        console.log(`❌ Channel not found: ${channelName}`);
        continue;
      }

      for (const platform of platformList) {

        const channelId =
          channel.platforms?.[platform];

        if (!channelId) {
          console.log(
            `❌ No channelId for ${channelName} / ${platform}`
          );
          continue;
        }

        console.log(
          `➡️ Updating ${channelName} | ${platform} | ${channelId}`
        );

        let data;

        try {
          data = await getPromos(channelId);
        } catch (err) {
          console.error(
            `❌ Stormforge fetch failed ${channelId}`,
            err.message
          );
          continue;
        }

        if (!data) {
          continue;
        }

        data = ensureFillerConfig(data);

        let urls =
          data.ssai_configuration.filler_config.url || [];

        /*
         * Remove any previous promo
         * having same filename
         */
        urls = urls.filter(url => {
          try {
            return !url.endsWith(filename);
          } catch {
            return true;
          }
        });

        /*
         * Add latest upload at top
         */
        urls.unshift(cfUrl);

        data.ssai_configuration.filler_config.url =
          urls;

        try {
          await putPromos(channelId, data);

          console.log(
            `✅ Updated ${channelName} | ${platform}`
          );

        } catch (err) {

          console.error(
            `❌ Stormforge update failed ${channelId}`,
            err.message
          );

          continue;
        }

        deliveries.push({
          channel: channelName,
          platform,
          channelId
        });

        /* ---------- Audit Log ---------- */
        await Log.create({
          action: "UPLOAD_PROMO",
          userEmail: req.user.email,
          channel: channelName,
          platform,
          channelId,
          details: {
            filename,
            url: cfUrl,
            overwritten: true
          }
        });
      }
    }

    /* ---------- Cleanup temp file ---------- */
    try {
      fs.unlinkSync(req.file.path);
    } catch (err) {
      console.warn(
        "Failed to remove temp file:",
        err.message
      );
    }

    res.json({
      success: true,
      filename,
      url: cfUrl,
      deliveries,
      channelsProcessed: selectedChannels.length,
      platformsProcessed: platformList.length
    });

  } catch (err) {

    console.error(
      "❌ Upload error:",
      err
    );

    res.status(500).json({
      error: err.message
    });
  }
});

export default router;