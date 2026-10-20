import mongoose from "mongoose";

/* Stores the verdict + headline numbers of each render-rate RCA run.
   Raw Athena rows are NOT stored (they can be tens of thousands of
   rows); re-run the analysis to see them. */
const renderRateInvestigationSchema = new mongoose.Schema({
  channelId:     { type: String, required: true, index: true },
  deliveryName:  { type: String },
  date:          { type: String, required: true },   // YYYY-MM-DD (UTC)
  hour:          { type: Number, required: true },   // 0-23 (UTC)
  clusters:      [{ type: String }],

  status:        { type: String },   // e.g. "RENDER_TRANSCODE_FAILURE"
  confidence:    { type: String },   // "HIGH" | "MEDIUM" | "LOW" | "NONE"
  headline:      { type: String },
  reason:        { type: String },
  primaryFactor: { type: String },

  factors:       { type: mongoose.Schema.Types.Mixed },
  metrics:       { type: mongoose.Schema.Types.Mixed },
  report:        { type: String },

  queriedBy:     { type: String },
}, { timestamps: true });

export default mongoose.model("RenderRateInvestigation", renderRateInvestigationSchema);
