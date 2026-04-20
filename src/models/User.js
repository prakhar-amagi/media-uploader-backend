import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: "user" },
  channels: [String],

  isActive: { type: Boolean, default: false },

  resetToken: String,
  resetTokenExpiry: Number
}, { timestamps: true });

export default mongoose.model("User", userSchema);
