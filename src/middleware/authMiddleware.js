import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { verifyToken } from "../utils/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USERS_FILE = path.join(__dirname, "../data/users.json");

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ error: "No token" });
  }

  const token = header.split(" ")[1];
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const users = JSON.parse(
    fs.readFileSync(USERS_FILE, "utf-8")
  );

  const fullUser = users.find(u => u.email === decoded.email);

  if (!fullUser) {
    return res.status(401).json({ error: "User not found" });
  }

  req.user = fullUser;
  next();
}
