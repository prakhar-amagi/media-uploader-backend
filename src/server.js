import "./env.js";
import express from "express";

import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import uploadRoutes from "./routes/upload.js";
import promoRoutes from "./routes/promos.js";
import channelRoutes from "./routes/channels.js";

import { connectDB } from "./db/mongo.js";

const app = express();

/* ---------- MIDDLEWARE ---------- */
app.use(express.json());
app.use(express.static("public"));

/* ---------- DB CONNECTION ---------- */
connectDB();

/* ---------- ROUTES ---------- */
app.get("/health", (_, res) => res.json({ status: "OK" }));

app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/upload", uploadRoutes);
app.use("/promos", promoRoutes);
app.use("/channels", channelRoutes);

/* ---------- SERVER ---------- */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
