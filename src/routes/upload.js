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
    const { channelName, platforms } = req.body;

    if (!channelName || !platforms || !req.file) {
      return res.status(400).json({
        error: "channelName, platforms & file required"
      });
    }

    const platformList = JSON.parse(platforms);

    const channel = await Channel.findOne({ channel: channelName });

    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    /* Upload to S3 */
    const filename = `${Date.now()}-${sanitizeFilename(req.file.originalname)}`;
    const cfUrl = await uploadToS3(req.file.path, filename);

    const deliveries = [];

    for (const platform of platformList) {
      const channelId = channel.platforms[platform];

      if (!channelId) {
        console.log(`❌ No channelId for ${platform}`);
        continue;
      }

      console.log(`➡️ Updating ${platform} → ${channelId}`);

      let data = await getPromos(channelId);

      if (!data) {
        console.log(`❌ No Stormforge data for ${channelId}`);
        continue;
      }

      data = ensureFillerConfig(data);

      let urls = data.ssai_configuration.filler_config.url;

      let added = false;

      if (!urls.includes(cfUrl)) {
        urls.unshift(cfUrl);
        data.ssai_configuration.filler_config.url = urls;

        await putPromos(channelId, data);

        console.log(`✅ Updated ${platform}`);
        added = true;
      } else {
        console.log(`⚠️ URL already exists for ${platform}`);
      }

      deliveries.push(channelId);

      /* ✅ LOG PER PLATFORM (KEY CHANGE) */
      await Log.create({
        action: "UPLOAD_PROMO",
        userEmail: req.user.email,
        channel: channelName,
        platform,
        channelId,
        details: {
          url: cfUrl,
          filename,
          added
        }
      });
    }

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      url: cfUrl,
      deliveries
    });

  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
