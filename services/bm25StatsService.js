const TermStats = require('../models/TermStats');
const { tokenizeText } = require('./ingestion/vectorEngine');

// ─── In-process TTL cache (botId → { stats, ts }) ────────────────────────────
const _statsCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── CorpusStatsBuilder ───────────────────────────────────────────────────────

/**
 * Accumulates per-chunk token counts and per-term document frequencies
 * during Phase 1 of the two-pass ingestion pipeline.
 *
 * Usage:
 *   const builder = new CorpusStatsBuilder();
 *   builder.addChunks(pageResult.childChunks);
 *   const stats = builder.build();
 */
class CorpusStatsBuilder {
  constructor() {
    this.totalChunks = 0;
    this.totalTokens = 0;
    this.termDf = {}; // term (string) → number of chunks containing that term
  }

  /**
   * Registers an array of child chunk objects into the corpus stats.
   * Each unique term is counted ONCE per chunk (document frequency semantics).
   *
   * @param {object[]} childChunks
   */
  addChunks(childChunks) {
    for (const chunk of childChunks) {
      const text = chunk.contextualText || chunk.text || '';
      const tokens = tokenizeText(text);
      if (tokens.length === 0) continue;

      this.totalChunks++;
      this.totalTokens += tokens.length;

      // df counts unique terms per chunk — NOT raw occurrences
      const uniqueTerms = new Set(tokens);
      for (const term of uniqueTerms) {
        this.termDf[term] = (this.termDf[term] || 0) + 1;
      }
    }
  }

  /**
   * Returns the finalized corpus stats object ready for persistence.
   *
   * @returns {{ totalChunks: number, totalTokens: number, termDf: object }}
   */
  build() {
    return {
      totalChunks: this.totalChunks,
      totalTokens: this.totalTokens,
      termDf: this.termDf,
    };
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persists corpus stats to MongoDB and immediately warms the in-process cache.
 * Called once at the end of Phase 1 (after all pages are scraped and chunked).
 *
 * @param {string|import('mongoose').Types.ObjectId} botId
 * @param {{ totalChunks: number, totalTokens: number, termDf: object }} corpusStats
 * @returns {Promise<object>} - The saved MongoDB document
 */
async function saveTermStats(botId, corpusStats) {
  const key = botId.toString();

  const doc = await TermStats.findOneAndUpdate(
    { botId },
    {
      botId,
      totalChunks: corpusStats.totalChunks,
      totalTokens: corpusStats.totalTokens,
      termDf:      corpusStats.termDf,
      updatedAt:   new Date(),
    },
    { upsert: true, new: true },
  );

  // Warm the cache immediately so the first post-ingestion query
  // gets real BM25 scores without a round-trip to MongoDB.
  const plain = doc.toObject ? doc.toObject() : doc;
  _statsCache.set(key, { stats: plain, ts: Date.now() });

  return plain;
}

/**
 * Deletes corpus stats from MongoDB and evicts the cache entry.
 * Called from deleteCollection() when a bot is reset or deleted.
 *
 * @param {string|import('mongoose').Types.ObjectId} botId
 */
async function deleteTermStats(botId) {
  const key = botId.toString();
  try {
    await TermStats.deleteOne({ botId });
  } catch (_) {}
  _statsCache.delete(key);
}

// ─── Retrieval (with TTL cache) ───────────────────────────────────────────────

/**
 * Loads corpus stats for a bot with a 5-minute in-process TTL cache.
 *
 * Returns null if no TermStats document exists yet (e.g. before first ingestion).
 * Callers must handle null gracefully and fall back to TF-only BM25.
 *
 * @param {string|import('mongoose').Types.ObjectId} botId
 * @returns {Promise<object|null>}
 */
async function loadCorpusStats(botId) {
  const key = botId.toString();

  const cached = _statsCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.stats;
  }

  try {
    const doc = await TermStats.findOne({ botId }).lean();
    if (!doc) {
      return null;
    }
    _statsCache.set(key, { stats: doc, ts: Date.now() });
    return doc;
  } catch (err) {
    console.warn(`⚠️ [BM25 Stats] Could not load TermStats for bot=${botId}:`, err.message);
    return null;
  }
}

module.exports = {
  CorpusStatsBuilder,
  saveTermStats,
  deleteTermStats,
  loadCorpusStats,
};
