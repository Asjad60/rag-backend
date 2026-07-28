const mongoose = require('mongoose');

/**
 * Per-bot BM25 corpus statistics.
 *
 * Stores the term document frequencies (df) and total chunk counts
 * required for computing true BM25 IDF weights at vectorization time.
 *
 * One document per bot — atomically replaced on each full re-ingestion run.
 *
 * Fields:
 *   totalChunks  — N: total indexed child chunks in this bot's corpus
 *   totalTokens  — sum of token counts across all chunks (used to compute avgdl)
 *   termDf       — plain object: { term (string) → df (int) }
 *                  Keys are lowercased, alphanumeric+hyphen only (safe for BSON).
 */
const termStatsSchema = new mongoose.Schema(
  {
    botId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bot',
      required: true,
      unique: true,
      index: true,
    },
    totalChunks: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    termDf:      { type: Object, default: {} }, // term → document frequency
    updatedAt:   { type: Date,   default: Date.now },
  },
  {
    // strict: false lets Mongoose preserve all dynamic termDf keys
    // without stripping them as "unknown paths".
    strict: false,
  },
);

module.exports = mongoose.model('TermStats', termStatsSchema);
