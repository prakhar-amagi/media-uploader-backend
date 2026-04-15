import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { requireAuth } from "../middleware/authMiddleware.js";
import { getChannelObjects, addChannel, deleteChannel } from "../utils/channelMap.js";
import { sendEmail } from "../utils/email.js";

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

const USERS_FILE = path.join(process.cwd(), "src/data/users.json");

/* ================= USERS ================= */

/* -------- GET ALL USERS -------- */
router.get("/users", (req, res) => {
  const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));

  const safeUsers = users.map(({ password, resetToken, resetTokenExpiry, ...rest }) => rest);

  res.json(safeUsers);
});

/* -------- CREATE USER (UPDATED) -------- */
router.post("/users", async (req, res) => {
  const { name, email, role } = req.body;

  // ✅ FIXED VALIDATION
  if (!name || !email) {
    return res.status(400).json({ error: "Name and email required" });
  }

  const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));

  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: "User already exists" });
  }

  // 🔐 Generate token
  const token = crypto.randomBytes(32).toString("hex");

  const newUser = {
    name,
    email,
    password: null,
    role: role || "user",
    channels: [],
    isActive: false,
    resetToken: token,
    resetTokenExpiry: Date.now() + 1000 * 60 * 60 // 1 hour
  };

  users.push(newUser);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

  try {
    const link = `http://localhost:3000/set-password.html?token=${token}`;

    await sendEmail(
      email,
      "Set your password",
      `<p>You were added to Promo Manager</p>
       <a href="${link}">Set Password</a>`
    );

    res.json({ success: true });

  } catch (err) {
    console.error("Email error:", err);
    res.status(500).json({ error: "User created but email failed" });
  }
});

/* -------- UPDATE USER CHANNELS -------- */
router.put("/users/:email", (req, res) => {
  const { email } = req.params;
  const { channels } = req.body;

  const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  const userIndex = users.findIndex(u => u.email === email);

  if (userIndex === -1) {
    return res.status(404).json({ error: "User not found" });
  }

  if (users[userIndex].role === "admin") {
    return res.status(400).json({ error: "Cannot modify admin channels" });
  }

  users[userIndex].channels = channels || [];

  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

  res.json({ success: true });
});

/* -------- DELETE USER -------- */
router.delete("/users/:email", (req, res) => {
  const { email } = req.params;

  const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  const user = users.find(u => u.email === email);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  if (user.role === "admin") {
    return res.status(400).json({ error: "Cannot delete admin user" });
  }

  const updatedUsers = users.filter(u => u.email !== email);

  fs.writeFileSync(USERS_FILE, JSON.stringify(updatedUsers, null, 2));

  res.json({ success: true });
});

/* ================= CHANNELS ================= */

/* -------- GET ALL CHANNELS -------- */
router.get("/channels", (req, res) => {
  res.json(getChannelObjects());
});

/* -------- ADD CHANNEL -------- */
router.post("/channels", (req, res) => {
  const { channel, samsung, xiaomi, lg } = req.body;

  if (!channel) {
    return res.status(400).json({ error: "Channel name required" });
  }

  try {
    addChannel({
      channel,
      platforms: {
        ...(samsung && { Samsung: samsung }),
        ...(xiaomi && { Xiaomi: xiaomi }),
        ...(lg && { LG: lg })
      }
    });

    res.json({ success: true });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------- UPDATE CHANNEL -------- */
router.put("/channels/:name", (req, res) => {
  const { name } = req.params;
  const { samsung, xiaomi, lg } = req.body;

  const channels = getChannelObjects();
  const index = channels.findIndex(c => c.channel === name);

  if (index === -1) {
    return res.status(404).json({ error: "Channel not found" });
  }

  channels[index].platforms = {
    ...(samsung && { Samsung: samsung }),
    ...(xiaomi && { Xiaomi: xiaomi }),
    ...(lg && { LG: lg })
  };

  fs.writeFileSync(
    path.join(process.cwd(), "src/data/channels.json"),
    JSON.stringify(channels, null, 2)
  );

  res.json({ success: true });
});

/* -------- DELETE CHANNEL -------- */
router.delete("/channels/:name", (req, res) => {
  const { name } = req.params;

  try {
    deleteChannel(name);

    const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));

    users.forEach(user => {
      user.channels = user.channels.filter(c => c !== name);
    });

    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

    res.json({ success: true });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
