import express from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import Channel from "../models/Channel.js";
import { getPlatformNames, canAccessChannel } from "../utils/platforms.js";

const router = express.Router();
router.use(requireAuth);

/* ---------------- GET ALL CHANNELS (names) ---------------- */
router.get("/", async (req, res) => {
  try {
    if (req.user.role === "admin") {
      const channels = await Channel.find().sort({ channel: 1 });
      return res.json(channels.map(c => c.channel));
    }

    // user → only allowed channels
    return res.json(req.user.channels || []);

  } catch (err) {
    console.error("Channel fetch error:", err);
    res.status(500).json({ error: "Failed to load channels" });
  }
});

/* ---------------- PLATFORMS FOR SEVERAL CHANNELS ----------------
   POST /channels/platforms  { channels: ["Zee News", "NDTV India"] }
   -> { platforms: { "Zee News": ["Samsung","LG"], ... },
        notFound: [...], forbidden: [...] }
   Platform names come from the channel's configuration in the admin panel.
------------------------------------------------------------------ */
router.post("/platforms", async (req, res) => {
  try {
    const requested = Array.isArray(req.body?.channels) ? req.body.channels.map(String) : [];
    if (!requested.length) return res.status(400).json({ error: "channels[] required" });

    const allowed = requested.filter((c) => canAccessChannel(req.user, c));
    const forbidden = requested.filter((c) => !allowed.includes(c));

    const docs = await Channel.find({ channel: { $in: allowed } });
    const byName = new Map(docs.map((d) => [d.channel, d]));

    const platforms = {};
    const notFound = [];
    for (const name of allowed) {
      const doc = byName.get(name);
      if (!doc) { notFound.push(name); continue; }
      platforms[name] = getPlatformNames(doc);
    }

    res.json({ platforms, notFound, forbidden });
  } catch (err) {
    console.error("Platform batch load error:", err);
    res.status(500).json({ error: "Platform load error" });
  }
});

/* ---------------- GET PLATFORMS FOR A CHANNEL ---------------- */
router.get("/:channelName", async (req, res) => {
  try {
    const channelName = decodeURIComponent(req.params.channelName);

    if (!canAccessChannel(req.user, channelName)) {
      return res.status(403).json({ error: "No access to this channel" });
    }

    const channel = await Channel.findOne({ channel: channelName });

    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    // platform names only (IDs stay server-side)
    res.json(getPlatformNames(channel));

  } catch (err) {
    console.error("Platform load error:", err);
    res.status(500).json({ error: "Platform load error" });
  }
});

export default router;
