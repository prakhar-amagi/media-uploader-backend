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
    const channelName = req.params.channelName;

    // 🔐 Access control
    if (req.user.role !== "admin") {
      if (!req.user.channels.includes(channelName)) {
        return res.status(403).json({ error: "No access to this channel" });
      }
    }

    const channel = await Channel.findOne({ channel: channelName });

    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    res.json(channel.platforms);

  } catch (err) {
    console.error("Platform load error:", err);
    res.status(500).json({ error: "Platform load error" });
  }
});

export default router;
