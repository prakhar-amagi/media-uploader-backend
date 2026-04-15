import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHANNELS_PATH = path.join(__dirname, "../data/channels.json");

/* ---------- Always Read Fresh Data ---------- */
function readData() {
  return JSON.parse(
    fs.readFileSync(CHANNELS_PATH, "utf-8")
  );
}

/* ---------- Write Data ---------- */
function writeData(data) {
  fs.writeFileSync(
    CHANNELS_PATH,
    JSON.stringify(data, null, 2)
  );
}

/* =====================================================
   PUBLIC SAFE FUNCTIONS (Used Across App)
===================================================== */

/* ---------- Get Channel Names (SAFE FOR DASHBOARD) ---------- */
export function getChannels() {
  const data = readData();
  return data.map(c => c.channel);
}

/* ---------- Get Full Channel Objects (ADMIN USE) ---------- */
export function getChannelObjects() {
  return readData();
}

/* ---------- Add Channel With Platforms ---------- */
export function addChannel({ channel, platforms }) {
  const data = readData();

  if (data.find(c => c.channel === channel)) {
    throw new Error("Channel already exists");
  }

  data.push({
    channel,
    platforms: platforms || {}
  });

  writeData(data);
}

/* ---------- Delete Channel ---------- */
export function deleteChannel(name) {
  let data = readData();

  if (!data.find(c => c.channel === name)) {
    throw new Error("Channel not found");
  }

  data = data.filter(c => c.channel !== name);
  writeData(data);
}

/* ---------- Get Platforms (Return Platform Names) ---------- */
export function getPlatforms(channelName) {
  const data = readData();
  const channel = data.find(c => c.channel === channelName);

  if (!channel) return [];

  return Object.keys(channel.platforms);
}

/* ---------- Resolve Platform IDs (FOR PROMO UPLOAD) ---------- */
export function resolveChannelIds(channelName, platforms) {
  const data = readData();
  const channel = data.find(c => c.channel === channelName);

  if (!channel) throw new Error("Invalid channel");

  return platforms
    .map(p => channel.platforms[p])
    .filter(Boolean);
}
