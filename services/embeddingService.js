const axios = require('axios');
const { logLlmUsage } = require('./llmUsageService');

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small';
const EMBEDDING_DIM = 1536;

// High-performance LRU Cache for query embeddings (Max 1000 items)
const EMBEDDING_CACHE = new Map();
const MAX_CACHE_SIZE = 1000;

function getCachedVector(key) {
  if (EMBEDDING_CACHE.has(key)) {
    const val = EMBEDDING_CACHE.get(key);
    // Refresh position in Map for LRU behavior
    EMBEDDING_CACHE.delete(key);
    EMBEDDING_CACHE.set(key, val);
    return val;
  }
  return null;
}

function setCachedVector(key, vector) {
  if (EMBEDDING_CACHE.size >= MAX_CACHE_SIZE) {
    // Delete oldest entry
    const oldestKey = EMBEDDING_CACHE.keys().next().value;
    EMBEDDING_CACHE.delete(oldestKey);
  }
  EMBEDDING_CACHE.set(key, vector);
}

/**
 * Generates a 1536-dim embedding vector using OpenRouter API.
 * @param {string|string[]} input - The text string or array of strings to embed.
 * @param {object} [options] - Optional botId, sessionId, operation.
 * @returns {Promise<number[]|number[][]>} - The embedding vector(s).
 */
async function generateEmbeddings(input, options = {}) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

    const isArray = Array.isArray(input);
    const textInput = isArray ? input : [input];

    // Check single-string cache hit for 0ms lookup
    if (!isArray && typeof input === 'string') {
      const cacheKey = input.trim();
      const cached = getCachedVector(cacheKey);
      if (cached) {
        console.log(`⚡ [Embedding Cache HIT] "${cacheKey.slice(0, 40)}..." (0ms)`);
        return cached;
      }
    }

    const response = await axios.post(
      'https://openrouter.ai/api/v1/embeddings',
      {
        model: EMBEDDING_MODEL,
        input: textInput,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://ragchatbot.local',
          'X-Title': 'RAG Chatbot',
        },
        timeout: 20_000,
      }
    );

    const data = response.data?.data;
    if (!data || !Array.isArray(data) || data.length === 0) {
      throw new Error('Invalid embedding response structure from OpenRouter');
    }

    // Log embedding usage for observability
    const usage = response.data?.usage;
    if (usage) {
      logLlmUsage({
        botId: options.botId || null,
        sessionId: options.sessionId || '',
        operation: options.operation || 'dense_embedding',
        modelName: EMBEDDING_MODEL,
        openRouterUsage: usage,
      }).catch(() => {});
    }

    if (isArray) {
      return data.map((item, idx) => {
        const vec = item.embedding;
        if (!vec || vec.length !== EMBEDDING_DIM) {
          throw new Error(`Unexpected embedding dimension at index ${idx}: got ${vec?.length}, expected ${EMBEDDING_DIM}`);
        }
        return vec;
      });
    } else {
      const vector = data[0].embedding;
      if (!vector || vector.length !== EMBEDDING_DIM) {
        throw new Error(`Unexpected embedding dimension: got ${vector?.length}, expected ${EMBEDDING_DIM}`);
      }
      if (typeof input === 'string') {
        setCachedVector(input.trim(), vector);
      }
      return vector;
    }
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message;
    console.error('❌ OpenRouter Embedding error:', errMsg);
    throw new Error(`Failed to generate embedding via OpenRouter: ${errMsg}`);
  }
}

module.exports = { generateEmbeddings, EMBEDDING_DIM, EMBEDDING_MODEL };
