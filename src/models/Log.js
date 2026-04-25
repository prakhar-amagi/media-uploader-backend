import mongoose from "mongoose";

const logSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: [
        "CREATE_USER",
        "DELETE_USER",
        "UPDATE_USER_CHANNELS",
        "CREATE_CHANNEL",
        "DELETE_CHANNEL",
        "CHANNEL_ID_CHANGE",
        "UPLOAD_PROMO",
        "DELETE_PROMO"
      ],
      required: true
    },
    userEmail: String,
    channel: String,
    platform: String,
    channelId: String,
    details: Object
  },
  { timestamps: true }
);

export default mongoose.model("Log", logSchema);
