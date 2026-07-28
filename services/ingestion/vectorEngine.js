const crypto = require("crypto");
const { generateEmbeddings } = require("../embeddingService");

// ─── Deterministic UUID ───────────────────────────────────────────────────────

/**
 * Stage L: Generate Deterministic SHA-256 UUID (URL + Index + Hash).
 * Formats a SHA-256 hash into a valid RFC-4122 UUID v4/v5 format string
 * so Qdrant point IDs are 100% deterministic and idempotent.
 *
 * @param {string} url       - Page URL
 * @param {string} indexId   - Chunk index ID (e.g., 'parent_0' or '0_1')
 * @param {string} textHash  - Hash of chunk text
 * @returns {string}         - 36-char valid UUID string
 */
function generateDeterministicUUID(url, indexId, textHash) {
  const seed = `${url}::${indexId}::${textHash}`;
  const sha256Hex = crypto.createHash("sha256").update(seed).digest("hex");

  const part1 = sha256Hex.substring(0, 8);
  const part2 = sha256Hex.substring(8, 12);
  const part3 = "4" + sha256Hex.substring(13, 16);
  const variantHex = (
    (parseInt(sha256Hex.substring(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);
  const part4 = variantHex + sha256Hex.substring(17, 20);
  const part5 = sha256Hex.substring(20, 32);

  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

// ─── Stopwords ────────────────────────────────────────────────────────────────

// Common English stopwords — filtered to reduce noise in sparse BM25 indices.
const ENGLISH_STOPWORDS = new Set([
  "the",
  "be",
  "to",
  "of",
  "and",
  "a",
  "in",
  "that",
  "have",
  "i",
  "it",
  "for",
  "not",
  "on",
  "with",
  "he",
  "as",
  "you",
  "do",
  "at",
  "this",
  "but",
  "his",
  "by",
  "from",
  "they",
  "we",
  "say",
  "her",
  "she",
  "or",
  "an",
  "will",
  "my",
  "one",
  "all",
  "would",
  "there",
  "their",
  "what",
  "so",
  "up",
  "out",
  "if",
  "about",
  "who",
  "get",
  "which",
  "go",
  "me",
  "when",
  "make",
  "can",
  "like",
  "time",
  "no",
  "just",
  "him",
  "know",
  "take",
  "people",
  "into",
  "year",
  "your",
  "good",
  "some",
  "could",
  "them",
  "see",
  "other",
  "than",
  "then",
  "now",
  "look",
  "only",
  "come",
  "its",
  "over",
  "think",
  "also",
  "back",
  "after",
  "use",
  "two",
  "how",
  "our",
  "work",
  "first",
  "well",
  "way",
  "even",
  "new",
  "want",
  "because",
  "any",
  "these",
  "give",
  "day",
  "most",
  "us",
  "page",
  "site",
  "website",
  "www",
  "http",
  "https",
  "com",
]);

// ─── Term Index Mapping ───────────────────────────────────────────────────────

/**
 * 32-bit FNV-1a hash → unsigned integer in [0, 999_999].
 * Maps term strings to Qdrant sparse vector indices.
 *
 * Collision rate ≈ 0.5% at 10K terms in a 1M-slot space (birthday problem).
 * Collisions are handled downstream by score accumulation — acceptable for BM25.
 */
function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 1_000_000;
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

/**
 * Tokenizes text into clean, lowercase, non-stopword tokens.
 *
 * EXPORTED — used by CorpusStatsBuilder in bm25StatsService.js so that
 * corpus statistics and vectorization always use IDENTICAL tokenization.
 * Any change to this function must be matched in both callers.
 *
 * @param {string} text
 * @returns {string[]} Array of clean tokens
 */
function tokenizeText(text) {
  if (!text) return [];

  const rawTokens = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ") // keep word chars, whitespace, hyphens
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  const filtered = rawTokens.filter((t) => !ENGLISH_STOPWORDS.has(t));
  // Fallback: if every token was a stopword, keep all raw tokens
  return filtered.length > 0 ? filtered : rawTokens;
}

// ─── True BM25 IDF ───────────────────────────────────────────────────────────

/**
 * BM25 IDF — Robertson–Sparck Jones always-positive variant:
 *   IDF(t) = log( (N − df(t) + 0.5) / (df(t) + 0.5) + 1 )
 *
 * Properties:
 *   df = 0  → IDF = log(2N + 1)  (max weight — term never seen in corpus)
 *   df = N  → IDF = log(1.5)     (min weight — term appears in every chunk)
 *   Always > 0 (no negative IDF for very common terms).
 *
 * @param {number} N  - Total chunks in corpus (N ≥ 1)
 * @param {number} df - Document frequency of this term (0 ≤ df ≤ N)
 * @returns {number}
 */
function computeIDF(N, df) {
  const safeN = Math.max(N, 1);
  const safeDf = Math.max(df, 0);
  return Math.log((safeN - safeDf + 0.5) / (safeDf + 0.5) + 1);
}

// ─── True BM25 Sparse Vector ──────────────────────────────────────────────────

/**
 * Stage K: Generates a TRUE BM25 sparse vector with real corpus-aware IDF.
 *
 * Full BM25 formula per term:
 *   TF_norm = tf × (k₁ + 1) / (tf + k₁ × (1 − b + b × |d| / avgdl))
 *   IDF     = log( (N − df + 0.5) / (df + 0.5) + 1 )
 *   BM25    = IDF × TF_norm
 *
 * Implementation notes:
 *   1. Term frequencies are computed from actual string maps (no hash collision
 *      on freq counting — collision only happens when mapping to Qdrant index).
 *   2. Qdrant index collisions (two different terms → same FNV-1a bucket) are
 *      handled by accumulating scores, not overwriting. Acceptable at <0.5% rate.
 *   3. Zero or negative BM25 scores are excluded from the sparse vector.
 *
 * Graceful fallback when corpusStats is null (before first ingestion or on error):
 *   N=1, avgdl=150, df=0 for all terms → IDF ≈ log(4) ≈ 1.39 (uniform).
 *   This gives TF-normalized sparse vectors — same as old behaviour.
 *
 * @param {string}      text        - Chunk or query text to vectorize
 * @param {object|null} corpusStats - { totalChunks, totalTokens, termDf }
 * @returns {{ indices: number[], values: number[] }}
 */
function generateBM25SparseVector(text, corpusStats = null) {
  if (!text) return { indices: [], values: [] };

  const tokens = tokenizeText(text);
  if (tokens.length === 0) return { indices: [], values: [] };

  // BM25 hyper-parameters (standard Lucene/Elasticsearch defaults)
  const k1 = 1.2; // term frequency saturation
  const b = 0.75; // document length normalisation weight

  const docLen = tokens.length;
  const N = corpusStats?.totalChunks || 1;
  const avgDocLen =
    corpusStats?.totalChunks > 0 && corpusStats?.totalTokens > 0
      ? corpusStats.totalTokens / corpusStats.totalChunks
      : 150; // Sensible default ≈ child chunk avg token count
  const termDf = corpusStats?.termDf || {};

  // ── Step 1: Per-term frequency (string-keyed — zero collisions at this stage) ─
  const termFreqs = new Map();
  for (const token of tokens) {
    termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
  }

  // ── Step 2: BM25 score per term → accumulate into Qdrant index map ────────
  const indexScores = new Map();

  for (const [term, tf] of termFreqs) {
    const df = termDf[term] || 0;
    const idf = computeIDF(N, df);
    const tfNorm =
      (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen)));
    const bm25 = idf * tfNorm;

    if (bm25 <= 0) continue;

    const idx = fnv1a32(term);
    // Accumulate on hash collision (rare, never silently drops a term's score)
    indexScores.set(idx, (indexScores.get(idx) || 0) + bm25);
  }

  // ── Step 3: Serialize to Qdrant sparse format ─────────────────────────────
  const indices = [];
  const values = [];
  for (const [idx, score] of indexScores) {
    indices.push(idx);
    values.push(parseFloat(score.toFixed(4)));
  }

  return { indices, values };
}

/**
 * Backward-compatible alias — all existing call sites (retrievalService.js)
 * import { generateSparseVector } and now transparently get real BM25.
 */
const generateSparseVector = generateBM25SparseVector;

// ─── Vectorization Engine ─────────────────────────────────────────────────────

/**
 * Stage I: Vectorization Engine.
 * Vectorizes a batch of child chunks into Qdrant point objects.
 *
 * Generates:
 *   - 1536-dim dense embeddings (text-embedding-3-small via OpenRouter)
 *   - True BM25 sparse vectors using corpus statistics
 *   - Deterministic SHA-256 UUIDs for idempotent upserts
 *
 * @param {object[]}    childChunks  - Array of child chunk objects
 * @param {string}      url          - Page URL
 * @param {object|null} corpusStats  - BM25 corpus stats ({ totalChunks, totalTokens, termDf })
 *                                     Pass null to use TF-only fallback (old behaviour)
 * @param {object}      [options]    - { botId, sessionId }
 * @returns {Promise<object[]>}      - Array of Qdrant point objects
 */
async function vectorizeChunks(
  childChunks,
  url,
  corpusStats = null,
  options = {},
) {
  if (!childChunks || childChunks.length === 0) return [];

  // Extract texts to embed
  const textsToEmbed = childChunks.map((c) => c.contextualText || c.text);

  // Generate 1536-dim dense embeddings in batch via OpenRouter
  const denseEmbeddings = await generateEmbeddings(textsToEmbed, {
    botId: options.botId,
    operation: "dense_embedding",
  });

  const points = childChunks.map((chunk, i) => {
    const denseVector = Array.isArray(denseEmbeddings[0])
      ? denseEmbeddings[i]
      : denseEmbeddings;
    const sparseVector = generateBM25SparseVector(
      chunk.contextualText || chunk.text,
      corpusStats,
    );
    const textHash = crypto
      .createHash("sha256")
      .update(chunk.text)
      .digest("hex");
    const pointId = generateDeterministicUUID(url, chunk.childIndex, textHash);

    return {
      id: pointId,
      vector: {
        "": denseVector, // 1536-dim dense vector
        sparse_vector: sparseVector, // True BM25 sparse vector { indices, values }
      },
      payload: {
        url,
        childIndex: chunk.childIndex,
        parentId: chunk.parentId,
        text: chunk.text,
        parentText: chunk.parentText,
        contextualText: chunk.contextualText,
        pageTitle: chunk.pageTitle || "",
        pageType: chunk.pageType || "general_page",
        contactEmails: chunk.contactEmails || [],
        contactPhones: chunk.contactPhones || [],
        tokenCount: chunk.tokenCount || 0,
        priceNumeric: chunk.ecommerceMeta?.priceNumeric ?? null,
        currency: chunk.ecommerceMeta?.currency || "INR",
        colors: chunk.ecommerceMeta?.colors || [],
        sizes: chunk.ecommerceMeta?.sizes || [],
      },
    };
  });

  return points;
}

module.exports = {
  generateDeterministicUUID,
  tokenizeText, // exported so CorpusStatsBuilder uses identical tokenization
  computeIDF, // exported for testing / diagnostics
  generateBM25SparseVector,
  generateSparseVector, // backward-compat alias
  vectorizeChunks,
};
