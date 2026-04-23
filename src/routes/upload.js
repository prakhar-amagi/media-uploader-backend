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

function ensureFillerConfig(data) {
  if (!data.ssai_configuration) data.ssai_configuration = {};
  if (!data.ssai_configuration.filler_config) {
    data.ssai_configuration.filler_config = {
      url: []
    };
  }
  return data;
}

router.post("/", upload.single("file"), async (req, res) => {
  try {
    const { channelName, platforms } = req.body;

    const platformList = JSON.parse(platforms);
    const channel = await Channel.findOne({ channel: channelName });

    const filename = sanitizeFilename(req.file.originalname);
    const cfUrl = await uploadToS3(req.file.path, filename);

    const deliveries = [];

    for (const platform of platformList) {
      const channelId = channel.platforms[platform];
      if (!channelId) continue;

      let data = await getPromos(channelId);
      if (!data) continue;

      data = ensureFillerConfig(data);

      let urls = data.ssai_configuration.filler_config.url;

      if (!urls.includes(cfUrl)) {
        urls.unshift(cfUrl);
        await putPromos(channelId, data);
      }

      deliveries.push(channelId);
    }

    fs.unlinkSync(req.file.path);

    await Log.create({
      action: "UPLOAD_PROMO",
      userEmail: req.user.email,
      channel: channelName,
      details: {
        platforms: platformList,
        url: cfUrl
      }
    });

    res.json({ success: true, url: cfUrl, deliveries });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
