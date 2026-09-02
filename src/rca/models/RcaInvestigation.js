import mongoose from "mongoose";

const rcaInvestigationSchema = new mongoose.Schema({
  channelId:       { type: String, required: true, index: true },
  deliveryName:    { type: String },
  demandTagId:     { type: Number, required: true },
  daysAnalyzed:    { type: Number },
  dateRange:       { type: String },

  status:          { type: String },   // e.g. "DEMAND_OPPORTUNITY_DECLINE"
  confidence:      { type: String },   // "HIGH" | "MEDIUM" | "LOW"
  reason:          { type: String },

  evidence:        { type: mongoose.Schema.Types.Mixed },

  queriedBy:       { type: String },   // user email from JWT
}, { timestamps: true });

export default mongoose.model("RcaInvestigation", rcaInvestigationSchema);
