import mongoose from "mongoose";

/*
 * platforms: free-form map of platform name -> StormForge channel ID, e.g.
 *   { "Samsung": "amg01448-samsungin-zeenews-samsungin",
 *     "LG": "amg02481-…-zeenews-lgin",
 *     "Vizio": "amg0xxxx-…" }
 *
 * This used to be a fixed { Samsung, Xiaomi, LG } sub-document, which made
 * Mongoose silently drop any other platform. Existing documents already use
 * this exact shape, so no migration is needed.
 *
 * Mixed type: always assign a NEW object (channel.platforms = {...}) rather
 * than mutating in place, or call channel.markModified("platforms").
 */
const channelSchema = new mongoose.Schema({
  channel: { type: String, unique: true, required: true, trim: true },
  platforms: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, minimize: false });

export default mongoose.model("Channel", channelSchema);
