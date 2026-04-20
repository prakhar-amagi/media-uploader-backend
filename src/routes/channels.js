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
    const allowed = channels
      .filter(c => req.user.channels.includes(c.channel))
      .map(c => c.channel);

    res.json(allowed);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- GET PLATFORMS FOR A CHANNEL ---------------- */
router.get("/:channelName", async (req, res) => {
  const { channelName } = req.params;

  try {
    // 🔐 ACCESS CONTROL
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
    res.status(500).json({ error: err.message });
  }
});

export default router;
