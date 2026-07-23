const mongoose = require("mongoose");

/**
 * Persists LLM and Embedding usage & cost metrics for observability.
 */
const LlmUsageSchema = new mongoose.Schema({
  botId: { type: mongoose.Schema.Types.ObjectId, ref: "Bot" },
  sessionId: { type: String, default: "" },
  operation: { type: String, required: true }, // e.g. 'contextual_summary', 'intent_detection', 'hyde_expansion', 'chat_response', 'clarify_response', 'dense_embedding', 'rerank'
  modelName: { type: String, required: true }, // e.g. 'openai/gpt-4o-mini', 'openai/text-embedding-3-small', 'cohere/rerank-v3.5'
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  cacheTokens: { type: Number, default: 0 },
  inputCost: { type: Number, default: 0 },
  outputCost: { type: Number, default: 0 },
  cacheCost: { type: Number, default: 0 },
  totalCost: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model("LlmUsage", LlmUsageSchema);
