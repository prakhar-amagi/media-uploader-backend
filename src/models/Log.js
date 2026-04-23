import mongoose from "mongoose";

const logSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "CREATE_CHANNEL",
        "UPDATE_CHANNEL",
        "DELETE_CHANNEL",
        "PROMO_UPLOAD",
        "PROMO_DELETE",
        "CHANNEL_ID_CHANGE"
      ]
    },
    userEmail: String,
    channel: String,
    platform: String,
    details: Object // flexible payload
  },
  {
    timestamps: true // ✅ auto adds createdAt (UTC)
  }
);

export default mongoose.model("Log", logSchema);
