import { requireAuth } from "../middleware/authMiddleware.js";
import express from "express";
import { getChannels, getPlatforms } from "../utils/channelMap.js";

const router = express.Router();
router.use(requireAuth);

/* ---------------- GET ALL CHANNELS ---------------- */
router.get("/", (req, res) => {
  if (req.user.role === "admin") {
    return res.json(getChannels());
  }

  // user role → only allowed channels
  res.json(req.user.channels || []);
});

/* ---------------- GET PLATFORMS FOR A CHANNEL ---------------- */
router.get("/:channelName", (req, res) => {
  const channelName = req.params.channelName;

  // 🔐 USER ACCESS CONTROL
  if (req.user.role !== "admin") {
    if (!req.user.channels.includes(channelName)) {
      return res.status(403).json({ error: "No access to this channel" });
    }
  }

  const platforms = getPlatforms(channelName);

  if (!platforms) {
    return res.status(404).json({ error: "Channel not found" });
  }

  res.json(platforms);
});

export default router;
