import express from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/authMiddleware.js";
import { sendEmail } from "../utils/email.js";

import User from "../models/User.js";
import Channel from "../models/Channel.js";
import Log from "../models/Log.js";

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

router.get("/channels", async (req, res) => {
  const channels = await Channel.find();
  res.json(channels);
});

router.post("/channels", async (req, res) => {
  const { channel, samsung, xiaomi, lg } = req.body;

  if (!channel) {
    return res.status(400).json({ error: "Channel name required" });
  }

  const platforms = {
    ...(samsung && { Samsung: samsung }),
    ...(xiaomi && { Xiaomi: xiaomi }),
    ...(lg && { LG: lg })
  };

  await Channel.create({ channel, platforms });

  await logAction(req, {
    action: "CREATE_CHANNEL",
    channel,
    details: platforms
  });

  res.json({ success: true });
});

router.put("/channels/:name", async (req, res) => {
  const { name } = req.params;
  const { samsung, xiaomi, lg } = req.body;

  const channel = await Channel.findOne({ channel: name });
  if (!channel) {
    return res.status(404).json({ error: "Channel not found" });
  }

  const oldPlatforms = channel.platforms;

  const updatedPlatforms = {
    ...(samsung && { Samsung: samsung }),
    ...(xiaomi && { Xiaomi: xiaomi }),
    ...(lg && { LG: lg })
  };

  channel.platforms = updatedPlatforms;
  await channel.save();

  await logAction(req, {
    action: "CHANNEL_ID_CHANGE",
    channel: name,
    details: { before: oldPlatforms, after: updatedPlatforms }
  });

  res.json({ success: true });
});

router.delete("/channels/:name", async (req, res) => {
  const { name } = req.params;

  await Channel.deleteOne({ channel: name });
  await User.updateMany({}, { $pull: { channels: name } });

  await logAction(req, {
    action: "DELETE_CHANNEL",
    channel: name
  });

  res.json({ success: true });
});

/* GET LOGS */
router.get("/logs", async (req, res) => {
  const logs = await Log.find().sort({ createdAt: -1 }).limit(200);
  res.json(logs);
});

export default router;
