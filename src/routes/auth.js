import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";

import { generateToken } from "../utils/auth.js";
import { sendEmail } from "../utils/email.js";

import User from "../models/User.js";

const router = express.Router();

/* ---------- LOGIN ---------- */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (!user) {
    return res.status(400).json({ error: "User not found" });
  }

  if (!user.isActive) {
    return res.status(403).json({ error: "Please activate your account via email" });
  }

  const match = await bcrypt.compare(password, user.password);

  if (!match) {
    return res.status(400).json({ error: "Invalid credentials" });
  }

  const token = generateToken(user);

  res.json({
    token,
    role: user.role,
    channels: user.channels,
    email: user.email
  });
});

/* ---------- SET PASSWORD (NEW USER ACTIVATION) ---------- */
router.post("/set-password", async (req, res) => {
  const { token, password } = req.body;

  const user = await User.findOne({
    resetToken: token,
    resetTokenExpiry: { $gt: Date.now() }
  });

  if (!user) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  user.password = await bcrypt.hash(password, 10);
  user.isActive = true;
  user.resetToken = null;
  user.resetTokenExpiry = null;

  await user.save();

  res.json({ success: true });
});

/* ---------- FORGOT PASSWORD ---------- */
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });

  // silent response (security best practice)
  if (!user) return res.json({ success: true });

  const token = crypto.randomBytes(32).toString("hex");

  user.resetToken = token;
  user.resetTokenExpiry = Date.now() + 1000 * 60 * 60;

  await user.save();


  const link = `${process.env.BASE_URL}/reset-password.html?token=${token}`;

  await sendEmail(
    email,
    "Reset Password",
    `<p>Click below to reset your password:</p>
     <a href="${link}">Reset Password</a>`
  );

  res.json({ success: true });
});

/* ---------- RESET PASSWORD ---------- */
router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;

  const user = await User.findOne({
    resetToken: token,
    resetTokenExpiry: { $gt: Date.now() }
  });

  if (!user) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  user.password = await bcrypt.hash(password, 10);
  user.resetToken = null;
  user.resetTokenExpiry = null;

  await user.save();

  res.json({ success: true });
});

export default router;
