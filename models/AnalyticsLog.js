const mongoose = require("mongoose");

/**
 * Persists analytics data for every chat turn.
 * Used for monitoring gaps, feedback collection, and pipeline debugging.
 */
const AnalyticsLogSchema = new mongoose.Schema({
  botId: { type: mongoose.Schema.Types.ObjectId, ref: "Bot", required: true },
  sessionId: { type: String, default: "" }, // Client-supplied session ID
  timestamp: { type: Date, default: Date.now },

  // ── Language ───────────────────────────────────────────────────────────────
  detectedLang: { type: String, default: "eng" }, // ISO 639-3 code
  isNonEnglish: { type: Boolean, default: false },

  // ── Pipeline routing ───────────────────────────────────────────────────────
  intent: { type: String, default: "general" }, // Detailed sub-intent
  ragPath: {
    type: String,
    enum: ["semantic", "structured", "clarify", "greeting", "none"],
    default: "semantic",
  },

  // ── Query & reply ──────────────────────────────────────────────────────────
  queryText: { type: String, default: "" }, // Original user message
  translatedQuery: { type: String, default: "" }, // English query used for retrieval
  replyText: { type: String, default: "" }, // Final reply sent to user

  // ── Retrieval stats ────────────────────────────────────────────────────────
  chunksRetrieved: { type: Number, default: 0 },

  // ── Safety ────────────────────────────────────────────────────────────────
  guardrailFired: { type: Boolean, default: false },

  // ── User feedback ─────────────────────────────────────────────────────────
  feedback: { type: String, enum: ["up", "down", null], default: null },
});

module.exports = mongoose.model("AnalyticsLog", AnalyticsLogSchema);
