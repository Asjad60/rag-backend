const { qdrantClient } = require('../../config/db');

const RRF_K = 60; // Standard Reciprocal Rank Fusion constant

/**
 * Stage H, I, J, K: Execute Qdrant Multi-Tenant Search & Reciprocal Rank Fusion (RRF).
 *
 * Retrieves Top 30 Dense Vectors (1536-dim) and Top 30 Sparse Matches (BM25 term indices)
 * filtered by collection (bot multi-tenant partition) and optional pageType,
 * then merges them using Reciprocal Rank Fusion (RRF).
 *
 * @param {string}   collectionName - Bot Qdrant collection (bot_<botId>)
 * @param {number[]} denseVector    - 1536-dim query embedding vector
 * @param {object}   sparseVector   - { indices, values } BM25 term indices
 * @param {string[]} allowedPageTypes - Optional page type filter array
 * @returns {Promise<Array>}        - RRF ranked list of candidate chunks
 */
async function executeHybridSearch(collectionName, denseVector, sparseVector = { indices: [] }, allowedPageTypes = []) {
  const filter = allowedPageTypes.length > 0
    ? { must: [{ key: 'pageType', match: { any: allowedPageTypes } }] }
    : undefined;

  let denseResults = [];
  let sparseResults = [];

  // 1. Retrieve Top 30 Dense Vectors (Stage I)
  try {
    denseResults = await qdrantClient.search(collectionName, {
      vector: denseVector,
      limit: 30,
      filter,
      with_payload: true,
      score_threshold: 0.15,
    });
  } catch (e) {
    const msg = e.message || '';
    if (!msg.toLowerCase().includes('not found') && !msg.includes('404')) {
      console.error('❌ Qdrant dense search error:', e.message);
    }
  }

  // Fallback: if dense search with pageType filter returned 0, retry without filter
  if (denseResults.length === 0 && allowedPageTypes.length > 0) {
    try {
      denseResults = await qdrantClient.search(collectionName, {
        vector: denseVector,
        limit: 30,
        with_payload: true,
      });
    } catch (_) {}
  }

  // 2. Retrieve Top 30 Sparse Matches (Stage J - BM25 Term Frequency Search)
  if (sparseVector && sparseVector.indices && sparseVector.indices.length > 0) {
    try {
      sparseResults = await qdrantClient.search(collectionName, {
        vector: {
          name: 'sparse_vector',
          vector: {
            indices: sparseVector.indices,
            values: sparseVector.values,
          },
        },
        limit: 30,
        filter,
        with_payload: true,
      });
    } catch (_) {
      // Fallback: If named sparse vector search is not configured on collection, retry with dense vector keyword fallback
      try {
        sparseResults = await qdrantClient.search(collectionName, {
          vector: denseVector,
          limit: 30,
          filter,
          with_payload: true,
        });
      } catch (_) {}
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
    .map(item => ({
      ...item.point,
      rrfScore: parseFloat(item.rrfScore.toFixed(6)),
      denseRank: item.denseRank,
      sparseRank: item.sparseRank,
    }));

  console.log(`🔀 [Hybrid Search & RRF] Merged ${denseResults.length} dense + ${sparseResults.length} sparse -> ${rrfRankedCandidates.length} unique candidates`);

  return rrfRankedCandidates;
}

module.exports = { executeHybridSearch };
