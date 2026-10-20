import express from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/authMiddleware.js";
import { sendEmail } from "../utils/email.js";

import User from "../models/User.js";
import Channel from "../models/Channel.js";
import Log from "../models/Log.js";
import {
  getChannelPlatforms,
  normalizePlatformsInput,
  diffPlatforms,
} from "../utils/platforms.js";

const router = express.Router();
router.use(requireAuth);

/* ---------- ADMIN ONLY ---------- */
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}
router.use(requireAdmin);

/* ---------- LOGGER (FIXED) ---------- */
async function logAction(req, data) {
  try {
    await Log.create({
      ...data,
      userEmail: req.user?.email || "unknown"
    });
  } catch (err) {
    console.error("Logging failed:", err);
  }
}

/* ================= USERS ================= */

router.get("/users", async (req, res) => {
  const users = await User.find().select("-password -resetToken -resetTokenExpiry");
  res.json(users);
});

router.post("/users", async (req, res) => {
  const { name, email, role } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "Name and email required" });
  }

  if (await User.findOne({ email })) {
    return res.status(400).json({ error: "User already exists" });
  }

  const token = crypto.randomBytes(32).toString("hex");

  await User.create({
    name,
    email,
    password: null,
    role: role || "user",
    channels: [],
    isActive: false,
    resetToken: token,
    resetTokenExpiry: Date.now() + 1000 * 60 * 60
  });

  await logAction(req, {
    action: "CREATE_USER",
    details: { createdUser: email }
  });

  const link = `${process.env.BASE_URL}/set-password.html?token=${token}`;

  await sendEmail(email, "Set your password", `
    <p>You were added to Promo Manager</p>
    <a href="${link}">Set Password</a>
  `);

  res.json({ success: true });
});

/* UPDATE USER CHANNELS */
router.put("/users/:email", async (req, res) => {
  const { email } = req.params;
  const { channels } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.role === "admin") {
    return res.status(400).json({ error: "Cannot modify admin channels" });
  }

  const oldChannels = user.channels;

  user.channels = channels || [];
  await user.save();

  await logAction(req, {
    action: "UPDATE_USER_CHANNELS",
    details: { user: email, before: oldChannels, after: channels }
  });

  res.json({ success: true });
});

/* DELETE USER */
router.delete("/users/:email", async (req, res) => {
  const { email } = req.params;

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: "User not found" });

  await User.deleteOne({ email });

  await logAction(req, {
    action: "DELETE_USER",
    details: { deletedUser: email }
  });

  res.json({ success: true });
});

/* ================= CHANNELS ================= */
/*
 * Body for create/update:
 *   { channel: "Zee News",
 *     platforms: [ { name: "Samsung", channelId: "amg01448-…" },
 *                  { name: "Vizio",   channelId: "amg0…" } ] }
 * The old { samsung, xiaomi, lg } fields are still accepted.
 */

router.get("/channels", async (req, res) => {
  try {
    const channels = await Channel.find().sort({ channel: 1 });
    res.json(channels.map((c) => ({
      _id: c._id,
      channel: c.channel,
      platforms: getChannelPlatforms(c),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })));
  } catch (err) {
    console.error("Admin channel list error:", err);
    res.status(500).json({ error: "Failed to load channels" });
  }
});

/* Platform names already in use, for suggestions in the admin form */
router.get("/platforms", async (req, res) => {
  try {
    const channels = await Channel.find();
    const counts = {};
    for (const c of channels) {
      for (const name of Object.keys(getChannelPlatforms(c))) {
        counts[name] = (counts[name] || 0) + 1;
      }
    }
    res.json(
      Object.entries(counts)
        .map(([name, channelCount]) => ({ name, channelCount }))
        .sort((a, b) => b.channelCount - a.channelCount || a.name.localeCompare(b.name))
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to load platforms" });
  }
});

router.post("/channels", async (req, res) => {
  try {
    const channel = String(req.body.channel || "").trim();
    if (!channel) {
      return res.status(400).json({ error: "Channel name required" });
    }

    const { platforms, errors } = normalizePlatformsInput(req.body);
    if (errors.length) {
      return res.status(400).json({ error: errors.join("; "), errors });
    }

    if (await Channel.findOne({ channel })) {
      return res.status(409).json({ error: `Channel "${channel}" already exists` });
    }

    await Channel.create({ channel, platforms });

    await logAction(req, {
      action: "CREATE_CHANNEL",
      channel,
      details: { platforms, platformCount: Object.keys(platforms).length }
    });

    res.json({ success: true, channel, platforms });
  } catch (err) {
    console.error("Create channel error:", err);
    if (err.code === 11000) return res.status(409).json({ error: "Channel already exists" });
    res.status(500).json({ error: err.message || "Failed to create channel" });
  }
});

router.put("/channels/:name", async (req, res) => {
  try {
    const { name } = req.params;

    const channel = await Channel.findOne({ channel: name });
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    const { platforms, errors } = normalizePlatformsInput(req.body);
    if (errors.length) {
      return res.status(400).json({ error: errors.join("; "), errors });
    }

    const before = getChannelPlatforms(channel);
    const diff = diffPlatforms(before, platforms);

    channel.platforms = platforms;      // new object -> Mixed change is detected
    channel.markModified("platforms");
    await channel.save();

    await logAction(req, {
      action: "CHANNEL_ID_CHANGE",
      channel: name,
      details: { before, after: platforms, ...diff }
    });

    res.json({ success: true, channel: name, platforms, ...diff });
  } catch (err) {
    console.error("Update channel error:", err);
    res.status(500).json({ error: err.message || "Failed to update channel" });
  }
});

router.delete("/channels/:name", async (req, res) => {
  try {
    const { name } = req.params;

    const existing = await Channel.findOne({ channel: name });
    if (!existing) return res.status(404).json({ error: "Channel not found" });

    await Channel.deleteOne({ channel: name });
    await User.updateMany({}, { $pull: { channels: name } });

    await logAction(req, {
      action: "DELETE_CHANNEL",
      channel: name,
      details: { platforms: getChannelPlatforms(existing) }
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Delete channel error:", err);
    res.status(500).json({ error: err.message || "Failed to delete channel" });
  }
});

/* GET LOGS (PAGINATED) */
router.get("/logs", async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1");
    const limitParam = req.query.limit || "20";

    const totalLogs = await Log.countDocuments();

    let logs;
    let totalPages;

    if (limitParam === "all") {
      logs = await Log.find()
        .sort({ createdAt: -1 });

      totalPages = 1;
    } else {
      const limit = parseInt(limitParam);

      logs = await Log.find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);

      totalPages = Math.ceil(totalLogs / limit);
    }

    res.json({
      logs,
      totalLogs,
      totalPages,
      currentPage: page
    });

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});
export default router;
