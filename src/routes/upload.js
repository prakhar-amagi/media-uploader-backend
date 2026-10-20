import express from "express";
import multer from "multer";
import fs from "fs";

import { requireAuth } from "../middleware/authMiddleware.js";
import { sanitizeFilename } from "../utils/filename.js";
import { uploadToS3 } from "../s3.js";
import { getPromos, putPromos } from "../stormforge.js";
import Channel from "../models/Channel.js";
import Log from "../models/Log.js";
import { resolvePlatformId, canAccessChannel } from "../utils/platforms.js";

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

/* ---------- Parse targets ----------
   New:    targets = [{ channel: "Zee News", platforms: ["Samsung","LG"] }, ...]
           (each channel has its own platform selection)
   Legacy: channelNames = [...], platforms = [...]  (same platforms for all)
-------------------------------------- */
function parseJsonField(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw Object.assign(new Error(`${field} must be valid JSON`), { status: 400 });
  }
}

function parseTargets(body) {
  const targets = parseJsonField(body.targets, "targets");

  let list;
  if (targets !== undefined) {
    if (!Array.isArray(targets)) throw Object.assign(new Error("targets must be an array"), { status: 400 });
    list = targets.map((t) => ({
      channel: String(t?.channel || "").trim(),
      platforms: Array.isArray(t?.platforms) ? t.platforms.map(String) : [],
    }));
  } else {
    const channelNames = parseJsonField(body.channelNames, "channelNames") || [];
    const platforms = parseJsonField(body.platforms, "platforms") || [];
    list = channelNames.map((channel) => ({ channel: String(channel), platforms: platforms.map(String) }));
  }

  // merge duplicates, drop empties
  const merged = new Map();
  for (const t of list) {
    if (!t.channel || !t.platforms.length) continue;
    const set = merged.get(t.channel) || new Set();
    t.platforms.forEach((p) => set.add(p));
    merged.set(t.channel, set);
  }
  return [...merged.entries()].map(([channel, set]) => ({ channel, platforms: [...set] }));
}

function cleanupTemp(file) {
  if (!file?.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch (err) {
    console.warn("Failed to remove temp file:", err.message);
  }
}

/* ---------- UPLOAD ---------- */
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "file required" });
    }

    const targets = parseTargets(req.body);
    if (!targets.length) {
      return res.status(400).json({ error: "Select at least one platform for at least one channel" });
    }

    /* ---------- Access check: refuse the whole request ---------- */
    const forbidden = targets.filter((t) => !canAccessChannel(req.user, t.channel)).map((t) => t.channel);
    if (forbidden.length) {
      return res.status(403).json({ error: `No access to channel(s): ${forbidden.join(", ")}` });
    }

    /* ---------- Resolve every target BEFORE uploading ---------- */
    const failures = [];
    const resolved = [];

    const docs = await Channel.find({ channel: { $in: targets.map((t) => t.channel) } });
    const byName = new Map(docs.map((d) => [d.channel, d]));

    for (const t of targets) {
      const doc = byName.get(t.channel);
      if (!doc) {
        t.platforms.forEach((platform) => failures.push({ channel: t.channel, platform, reason: "Channel not found" }));
        continue;
      }
      for (const platform of t.platforms) {
        const channelId = resolvePlatformId(doc, platform);
        if (!channelId) {
          failures.push({ channel: t.channel, platform, reason: "Platform not configured for this channel" });
          continue;
        }
        resolved.push({ channel: t.channel, platform, channelId });
      }
    }

    if (!resolved.length) {
      return res.status(400).json({
        error: "None of the selected channel/platform combinations are configured",
        failures,
      });
    }

    /* ---------- Upload to S3 ---------- */
    const filename = sanitizeFilename(req.file.originalname);
    const cfUrl = await uploadToS3(req.file.path, filename);

    const deliveries = [];

    /* ---------- Update StormForge per target ---------- */
    for (const { channel: channelName, platform, channelId } of resolved) {
      console.log(`➡️ Updating ${channelName} | ${platform} | ${channelId}`);

      let data;
      try {
        data = await getPromos(channelId);
      } catch (err) {
        console.error(`❌ Stormforge fetch failed ${channelId}`, err.message);
        failures.push({ channel: channelName, platform, channelId, reason: `StormForge fetch failed: ${err.message}` });
        continue;
      }

      if (!data) {
        failures.push({ channel: channelName, platform, channelId, reason: "StormForge returned no delivery config" });
        continue;
      }

      data = ensureFillerConfig(data);

      // Replace any previous promo with the same filename, newest first
      let urls = (data.ssai_configuration.filler_config.url || [])
        .filter((url) => typeof url !== "string" || !url.endsWith(filename));
      urls.unshift(cfUrl);
      data.ssai_configuration.filler_config.url = urls;

      try {
        await putPromos(channelId, data);
        console.log(`✅ Updated ${channelName} | ${platform}`);
      } catch (err) {
        console.error(`❌ Stormforge update failed ${channelId}`, err.message);
        failures.push({ channel: channelName, platform, channelId, reason: `StormForge update failed: ${err.message}` });
        continue;
      }

      deliveries.push({ channel: channelName, platform, channelId });

      /* ---------- Audit Log ---------- */
      await Log.create({
        action: "UPLOAD_PROMO",
        userEmail: req.user.email,
        channel: channelName,
        platform,
        channelId,
        details: { filename, url: cfUrl, overwritten: true }
      });
    }

    const status = deliveries.length ? 200 : 502;

    res.status(status).json({
      success: failures.length === 0,
      partial: deliveries.length > 0 && failures.length > 0,
      filename,
      url: cfUrl,
      deliveries,
      failures,
      channelsProcessed: targets.length,
      targetsRequested: targets.reduce((n, t) => n + t.platforms.length, 0),
      ...(status === 502 ? { error: "Upload to S3 succeeded but no StormForge delivery was updated" } : {})
    });

  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    cleanupTemp(req.file);
  }
});

export default router;
