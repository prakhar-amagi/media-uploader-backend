import mongoose from "mongoose";

const channelSchema = new mongoose.Schema({
  channel: { type: String, unique: true },
  platforms: {
    Samsung: String,
    Xiaomi: String,
    LG: String
  }
}, { timestamps: true });

export default mongoose.model("Channel", channelSchema);
