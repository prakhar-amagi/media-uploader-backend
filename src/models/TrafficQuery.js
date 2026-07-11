import mongoose from "mongoose";

const dailyBreakdownSchema = new mongoose.Schema({
  date:        { type: String },   // "2026-06-20"
  acu:         { type: Number },   // avg concurrent users that day
  impressions: { type: Number },   // total impressions that day
}, { _id: false });

const trafficQuerySchema = new mongoose.Schema({
  channelId:              { type: String, required: true, index: true },
  deliveryName:           { type: String },
  setup:                  { type: String, required: true },
  trafficSplitPct:        { type: Number },
  avgAcuPerDay:           { type: Number },
  avgImpressionsPerDay:   { type: Number },
  daysAnalyzed:           { type: Number },
  dailyBreakdown:         [dailyBreakdownSchema],
  queriedBy:              { type: String },   // user email from JWT
}, { timestamps: true });

export default mongoose.model("TrafficQuery", trafficQuerySchema);
