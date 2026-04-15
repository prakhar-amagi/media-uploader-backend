import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import fs from "fs";
import express from "express";

const router = express.Router();

const SECRET = process.env.JWT_SECRET || "supersecret";
const USERS_FILE = "./data/users.json";

/* ---------------- JWT ---------------- */

export function generateToken(user) {
  return jwt.sign(
    {
      email: user.email,
      role: user.role
    },
    SECRET,
    { expiresIn: "8h" }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

/* ---------------- SET PASSWORD ---------------- */

router.post("/set-password", async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: "Token and password required" });
  }

  const users = JSON.parse(fs.readFileSync(USERS_FILE));

  const user = users.find(u =>
    u.resetToken === token &&
    u.resetTokenExpiry > Date.now()
  );

  if (!user) {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  try {
    // Hash password
    user.password = await bcrypt.hash(password, 10);

    // Activate user
    user.isActive = true;

    // Clear reset token
    user.resetToken = null;
    user.resetTokenExpiry = null;

    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

    // ✅ Generate JWT token immediately after password set
    const jwtToken = generateToken(user);

    res.json({
      success: true,
      token: jwtToken,
      email: user.email,
      role: user.role
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to set password" });
  }
});

export default router;
