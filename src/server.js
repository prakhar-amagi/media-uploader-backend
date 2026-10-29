import "./env.js";
import express from "express";

import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import uploadRoutes from "./routes/upload.js";
import promoRoutes from "./routes/promos.js";
import channelRoutes from "./routes/channels.js";
import trafficRoutes from "./routes/traffic.js";
import rcaRoutes from "./rca/routes.js";

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
app.use("/traffic", trafficRoutes);
app.use("/rca", rcaRoutes);

/* ---------- SERVER ---------- */
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

/* Node closes any request still running after 5 minutes by default,
   which cuts off large promo batches mid-upload. Allow 30 minutes. */
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30 * 60 * 1000);
server.headersTimeout = 2 * 60 * 1000;
