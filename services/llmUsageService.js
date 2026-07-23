const LlmUsage = require("../models/LlmUsage");

/**
 * Model Pricing Rates (USD per token or request)
 */
const PRICING_REGISTRY = {
  "openai/gpt-4o-mini": {
    inputPerToken: 0.15 / 1_000_000,
    outputPerToken: 0.60 / 1_000_000,
    cachePerToken: 0.075 / 1_000_000,
  },
  "openai/text-embedding-3-small": {
    inputPerToken: 0.02 / 1_000_000,
    outputPerToken: 0,
    cachePerToken: 0,
  },
  "baai/bge-reranker-large": {
    perRequest: 0, // Free open-source reranker
  },
  "BAAI/bge-reranker-v2-m3": {
    perRequest: 0, // Free open-source reranker
  },
  "cohere/rerank-v3.5": {
    perRequest: 0.001,
  },
  default: {
    inputPerToken: 0.15 / 1_000_000,
    outputPerToken: 0.60 / 1_000_000,
    cachePerToken: 0.075 / 1_000_000,
  },
};

/**
 * Calculates costs and logs LLM usage in MongoDB for observability.
 * Non-blocking: failures will log console warnings but never disrupt primary execution.
 */
async function logLlmUsage({
  botId = null,
  sessionId = "",
  operation,
  modelName,
  inputTokens = 0,
  outputTokens = 0,
  cacheTokens = 0,
  openRouterUsage = null,
}) {
  try {
    let inTok = inputTokens;
    let outTok = outputTokens;
    let cacheTok = cacheTokens;

    if (openRouterUsage) {
      inTok = openRouterUsage.prompt_tokens ?? inTok;
      outTok = openRouterUsage.completion_tokens ?? outTok;
      cacheTok =
        openRouterUsage.prompt_tokens_details?.cached_tokens ??
        openRouterUsage.cache_tokens ??
        cacheTok;
    }

    const rates = PRICING_REGISTRY[modelName] || PRICING_REGISTRY["default"];

    let inputCost = 0;
    let outputCost = 0;
    let cacheCost = 0;
    let totalCost = 0;

    if (rates.perRequest) {
      totalCost = rates.perRequest;
    } else {
      const netInputTokens = Math.max(0, inTok - cacheTok);
      inputCost = netInputTokens * (rates.inputPerToken || 0);
      cacheCost = cacheTok * (rates.cachePerToken || 0);
      outputCost = outTok * (rates.outputPerToken || 0);
      totalCost = inputCost + outputCost + cacheCost;
    }

    const usageRecord = new LlmUsage({
      botId,
      sessionId,
      operation,
      modelName,
      inputTokens: inTok,
      outputTokens: outTok,
      cacheTokens: cacheTok,
      inputCost: parseFloat(inputCost.toFixed(8)),
      outputCost: parseFloat(outputCost.toFixed(8)),
      cacheCost: parseFloat(cacheCost.toFixed(8)),
      totalCost: parseFloat(totalCost.toFixed(8)),
      timestamp: new Date(),
    });

    await usageRecord.save();
    console.log(
      `📊 [LLM Usage Logged] op="${operation}" | model="${modelName}" | in=${inTok} out=${outTok} cache=${cacheTok} | cost=$${totalCost.toFixed(6)}`,
    );
    return usageRecord;
  } catch (err) {
    console.error("⚠️  LLM Usage logging error (non-fatal):", err.message);
    return null;
  }
}

module.exports = { logLlmUsage, PRICING_REGISTRY };
