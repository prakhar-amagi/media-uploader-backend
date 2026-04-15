import express from "express";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { generateToken } from "../utils/auth.js";
import { sendEmail } from "../utils/email.js";

const router = express.Router();

/* Fix __dirname */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USERS_PATH = path.join(__dirname, "../data/users.json");

/* ---------- LOGIN ---------- */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const users = JSON.parse(fs.readFileSync(USERS_PATH, "utf-8"));
  const user = users.find(u => u.email === email);

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

  const users = JSON.parse(fs.readFileSync(USERS_PATH, "utf-8"));

  const user = users.find(
    u => u.resetToken === token &&
    u.resetTokenExpiry > Date.now()
  );

  if (!user) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  user.password = await bcrypt.hash(password, 10);
  user.isActive = true; // ✅ important for activation
  user.resetToken = null;
  user.resetTokenExpiry = null;

  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));

  res.json({ success: true });
});

/* ---------- FORGOT PASSWORD ---------- */
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  const users = JSON.parse(fs.readFileSync(USERS_PATH, "utf-8"));
  const user = users.find(u => u.email === email);

  if (!user) return res.json({ success: true });

  const token = crypto.randomBytes(32).toString("hex");

  user.resetToken = token;
  user.resetTokenExpiry = Date.now() + 1000 * 60 * 60;

  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));

  const link = `http://localhost:3000/reset-password.html?token=${token}`;

  await sendEmail(email, "Reset Password", `
    <p>Click below to reset your password:</p>
    <a href="${link}">Reset Password</a>
  `);

  res.json({ success: true });
});

/* ---------- RESET PASSWORD ---------- */
router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;

  const users = JSON.parse(fs.readFileSync(USERS_PATH, "utf-8"));

  const user = users.find(
    u => u.resetToken === token &&
    u.resetTokenExpiry > Date.now()
  );

  if (!user) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  user.password = await bcrypt.hash(password, 10);
  user.resetToken = null;
  user.resetTokenExpiry = null;

  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));

  res.json({ success: true });
});

export default router;
