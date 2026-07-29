const { qdrantClient } = require("../../config/db");

const RRF_K = 60; // Standard Reciprocal Rank Fusion constant

/**
 * Stage H, I, J, K: Execute Qdrant Multi-Tenant Search & Reciprocal Rank Fusion (RRF).
 *
 * Retrieves Top 30 Dense Vectors (1536-dim) and Top 30 Sparse Matches (native BM25)
 * filtered by collection (bot multi-tenant partition) and optional pageType,
 * then merges them using Reciprocal Rank Fusion (RRF) in Node.js.
 *
 * Sparse BM25 search uses the Qdrant Universal Query API (.query()) with
 * { text, model: 'Qdrant/bm25' } — Qdrant Cloud applies IDF weighting server-side.
 *
 * @param {string}   collectionName    - Bot Qdrant collection (bot_<botId>)
 * @param {number[]} denseVector       - 1536-dim query embedding vector
 * @param {string}   sparseQueryText   - Raw query text for native BM25 sparse search
 * @param {string[]} allowedPageTypes  - Optional page type filter array
 * @param {object|array} extraFilter   - Optional additional Qdrant filters (e.g. price range)
 * @returns {Promise<Array>}           - RRF ranked list of candidate chunks
 */
async function executeHybridSearch(
  collectionName,
  denseVector,
  sparseQueryText = "",
  allowedPageTypes = [],
  extraFilter = null,
) {
  const mustConditions = [];
  if (allowedPageTypes.length > 0) {
    mustConditions.push({ key: "pageType", match: { any: allowedPageTypes } });
  }
  if (extraFilter) {
    if (Array.isArray(extraFilter)) {
      mustConditions.push(...extraFilter);
    } else {
      mustConditions.push(extraFilter);
    }
  }

  const filter =
    mustConditions.length > 0 ? { must: mustConditions } : undefined;

  let denseResults = [];
  let sparseResults = [];

  // 1. Retrieve Top 30 Dense Vectors (Stage I)
  try {
    denseResults = await qdrantClient.search(collectionName, {
      vector: denseVector,
      limit: 30,
      filter,
      with_payload: true,
      score_threshold: 0.05,
    });
  } catch (e) {
    const msg = e.message || "";
    if (!msg.toLowerCase().includes("not found") && !msg.includes("404")) {
      console.error("❌ Qdrant dense search error:", e.message);
    }
  }

  // Fallback 1: If dense search with strict extra filter returned 0, retry with pageType filter only
  if (denseResults.length === 0 && extraFilter) {
    console.log(
      "⚠️ [Hybrid Search] Strict payload filter returned 0 points — falling back to pageType filter",
    );
    const fallbackFilter =
      allowedPageTypes.length > 0
        ? { must: [{ key: "pageType", match: { any: allowedPageTypes } }] }
        : undefined;
    try {
      denseResults = await qdrantClient.search(collectionName, {
        vector: denseVector,
        limit: 30,
        filter: fallbackFilter,
        with_payload: true,
      });
    } catch (_) {}
  }

  // Fallback 2: if dense search still returned 0, retry without any filter
  if (denseResults.length === 0 && allowedPageTypes.length > 0) {
    try {
      denseResults = await qdrantClient.search(collectionName, {
        vector: denseVector,
        limit: 30,
        with_payload: true,
      });
    } catch (_) {}
  }

  // 2. Retrieve Top 30 Sparse Matches via Native Qdrant BM25 (Stage J)
  if (sparseQueryText && sparseQueryText.trim().length > 0) {
    try {
      const queryResult = await qdrantClient.query(collectionName, {
        query: {
          text: sparseQueryText.trim(),
          model: "Qdrant/bm25",
        },
        using: "sparse_vector",
        limit: 30,
        filter,
        with_payload: true,
      });
      // .query() returns { points: [...] } — normalise to flat array
      sparseResults = queryResult?.points ?? queryResult ?? [];
    } catch (e) {
      console.warn(
        "⚠️ [Hybrid Search] Native BM25 sparse query failed (legacy collection) — using dense fallback:",
        e.message
      );
      sparseResults = denseResults;
    }
  }

  // 3. Apply Reciprocal Rank Fusion (RRF) (Stage K)
  const candidateMap = new Map();

  // Process Dense Ranks
  denseResults.forEach((point, rank) => {
    const pointId = point.id;
    const denseRank = rank + 1; // 1-based rank
    const rrfContribution = 1.0 / (RRF_K + denseRank);

    candidateMap.set(pointId, {
      point,
      denseRank,
      sparseRank: 999, // default unranked
      rrfScore: rrfContribution,
    });
  });

  // Process Sparse Ranks
  sparseResults.forEach((point, rank) => {
    const pointId = point.id;
    const sparseRank = rank + 1; // 1-based rank
    const rrfContribution = 1.0 / (RRF_K + sparseRank);

    if (candidateMap.has(pointId)) {
      const existing = candidateMap.get(pointId);
      existing.sparseRank = sparseRank;
      existing.rrfScore += rrfContribution;
    } else {
      candidateMap.set(pointId, {
        point,
        denseRank: 999,
        sparseRank,
        rrfScore: rrfContribution,
      });
    }
  });

  // Sort candidates by RRF score descending
  const rrfRankedCandidates = Array.from(candidateMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map((item) => ({
      ...item.point,
      rrfScore: parseFloat(item.rrfScore.toFixed(6)),
      denseRank: item.denseRank,
      sparseRank: item.sparseRank,
    }));

  console.log(
    `🔀 [Hybrid Search & RRF] Merged ${denseResults.length} dense + ${sparseResults.length} sparse -> ${rrfRankedCandidates.length} unique candidates`,
  );

  return rrfRankedCandidates;
}

module.exports = { executeHybridSearch };
