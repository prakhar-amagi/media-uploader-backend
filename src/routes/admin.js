import express from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/authMiddleware.js";
import { sendEmail } from "../utils/email.js";

import User from "../models/User.js";
import Channel from "../models/Channel.js";

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

/* ================= USERS ================= */

/* -------- GET ALL USERS -------- */
router.get("/users", async (req, res) => {
  const users = await User.find().select("-password -resetToken -resetTokenExpiry");
  res.json(users);
});

/* -------- CREATE USER -------- */
router.post("/users", async (req, res) => {
  const { name, email, role } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "Name and email required" });
  }

  const existing = await User.findOne({ email });
  if (existing) {
    return res.status(400).json({ error: "User already exists" });
  }

  const token = crypto.randomBytes(32).toString("hex");

  const user = new User({
    name,
    email,
    password: null,
    role: role || "user",
    channels: [],
    isActive: false,
    resetToken: token,
    resetTokenExpiry: Date.now() + 1000 * 60 * 60
  });

  await user.save();

  try {

    const link = `${process.env.BASE_URL}/set-password.html?token=${token}`;

    await sendEmail(
      email,
      "Set your password",
      `<p>You were added to Promo Manager</p>
       <a href="${link}">Set Password</a>`
    );

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: "User created but email failed" });
  }
});

/* -------- UPDATE USER CHANNELS -------- */
router.put("/users/:email", async (req, res) => {
  const { email } = req.params;
  const { channels } = req.body;

  const user = await User.findOne({ email });

  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.role === "admin") {
    return res.status(400).json({ error: "Cannot modify admin channels" });
  }

  user.channels = channels || [];
  await user.save();

  res.json({ success: true });
});

/* -------- DELETE USER -------- */
router.delete("/users/:email", async (req, res) => {
  const { email } = req.params;

  const user = await User.findOne({ email });

  if (!user) return res.status(404).json({ error: "User not found" });

  if (user.role === "admin") {
    return res.status(400).json({ error: "Cannot delete admin user" });
  }

  await User.deleteOne({ email });

  res.json({ success: true });
});

/* ================= CHANNELS ================= */

/* -------- GET CHANNELS -------- */
router.get("/channels", async (req, res) => {
  const channels = await Channel.find();
  res.json(channels);
});

/* -------- ADD CHANNEL -------- */
router.post("/channels", async (req, res) => {
  const { channel, samsung, xiaomi, lg } = req.body;

  if (!channel) {
    return res.status(400).json({ error: "Channel name required" });
  }

  try {
    const newChannel = new Channel({
      channel,
      platforms: {
        ...(samsung && { Samsung: samsung }),
        ...(xiaomi && { Xiaomi: xiaomi }),
        ...(lg && { LG: lg })
      }
    });

    await newChannel.save();

    res.json({ success: true });

  } catch (err) {
    res.status(400).json({ error: "Channel already exists" });
  }
});

/* -------- UPDATE CHANNEL -------- */
router.put("/channels/:name", async (req, res) => {
  const { name } = req.params;
  const { samsung, xiaomi, lg } = req.body;

  const channel = await Channel.findOne({ channel: name });

  if (!channel) {
    return res.status(404).json({ error: "Channel not found" });
  }

  channel.platforms = {
    ...(samsung && { Samsung: samsung }),
    ...(xiaomi && { Xiaomi: xiaomi }),
    ...(lg && { LG: lg })
  };

  await channel.save();

  res.json({ success: true });
});

/* -------- DELETE CHANNEL -------- */
router.delete("/channels/:name", async (req, res) => {
  const { name } = req.params;

  const channel = await Channel.findOne({ channel: name });

  if (!channel) {
    return res.status(404).json({ error: "Channel not found" });
  }

  await Channel.deleteOne({ channel: name });

  // remove from users
  await User.updateMany(
    {},
    { $pull: { channels: name } }
  );

  res.json({ success: true });
});

export default router;
