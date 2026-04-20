import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import Channel from "../models/Channel.js";

const router = express.Router();
router.use(requireAuth);

/* ---------------- GET ALL CHANNELS ---------------- */
router.get("/", async (req, res) => {
  try {
    const channels = await Channel.find();

    if (req.user.role === "admin") {
      return res.json(channels.map(c => c.channel));
    }

    // user → only allowed channels
    return res.json(req.user.channels || []);

  } catch (err) {
    console.error("Channel fetch error:", err);
    res.status(500).json({ error: "Failed to load channels" });
  }
});

/* ---------------- GET PLATFORMS FOR A CHANNEL ---------------- */
router.get("/:channelName", async (req, res) => {
  try {
    // ✅ Fix 1: decode URL (handles spaces like Zee%20News)
    const channelName = decodeURIComponent(req.params.channelName).trim();

    // 🔐 Fix 2: safer access control (case-insensitive)
    if (req.user.role !== "admin") {
      const allowedChannels = (req.user.channels || []).map(c =>
        c.trim().toLowerCase()
      );

      if (!allowedChannels.includes(channelName.toLowerCase())) {
        return res.status(403).json({ error: "No access to this channel" });
      }
    }

    // ✅ Fix 3: case-insensitive DB search
    const channel = await Channel.findOne({
      channel: { $regex: `^${channelName}$`, $options: "i" }
    });

    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    // ✅ Always return safe object
    res.json(channel.platforms || {});

  } catch (err) {
    console.error("Platform load error:", err);
    res.status(500).json({ error: "Platform load error" });
  }
});

export default router;
