import Log from "../models/Log.js";

export async function logAction({
  action,
  user,
  channel,
  platform,
  details = {}
}) {
  try {
    await Log.create({
      action,
      userEmail: user?.email || "unknown",
      channel,
      platform,
      details
    });
  } catch (err) {
    console.error("Logging failed:", err);
  }
}
