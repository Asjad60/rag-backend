const { generateHyDEAndExpandQuery, resolveAmbiguousPronouns } = require("./retrieval/hydeService");
const { executeHybridSearch } = require("./retrieval/hybridSearch");
const { rerankCandidates } = require("./retrieval/reranker");
const { generateEmbeddings } = require("./embeddingService");
const { generateSparseVector } = require("./ingestion/vectorEngine");
const { getCollectionName } = require("./scraperService");

const INTENT_PAGE_TYPE_FILTER = {
  product: ["product_page", "pricing_page", "service_page", "homepage"],
  contact: ["contact_page"],
  about: ["about_page", "homepage"],
  faq: ["faq_page"],
  navigation: [],
  general: [],
};

/**
 * Stage D through O: Advanced Visitor Query Retrieval Pipeline.
 *
 * Pipeline Flow:
 *   1. Stage D: Query Context Expansion & HyDE
 *   2. Stage E-G: Dual Query Representations (1536-dim Dense + BM25 Sparse)
 *   3. Stage H-K: Qdrant Multi-Tenant Search & Reciprocal Rank Fusion (RRF)
 *   4. Stage L-N: 2nd-Stage Cohere Reranker (> 0.75 threshold) -> Top 5 Chunks
 *   5. Stage O: Resolve Matched Child Chunks to broader Parent Chunks
 *
 * @param {string} botId       - Bot MongoDB ID
 * @param {string} query       - User query string
 * @param {Array}  chatHistory - Recent conversation history
 * @param {string} intent      - Detected user intent
 * @returns {Promise<{ searchResults: Array, resolvedParentChunks: Array, hydeText: string }>}
 */
async function executeRetrievalPipeline(
  botId,
  query,
  chatHistory = [],
  intent = "general",
  options = {},
) {
  console.log(
    `\n🔎 [Retrieval Pipeline] Processing query for bot=${botId} | intent=${intent}`,
  );
  const collectionName = getCollectionName(botId);
  const opts = { botId, sessionId: options.sessionId || "", intent };

  const cleanedQuery = (query || "").trim();

  // Stage D-pre: Unconditional pronoun resolution (runs regardless of HyDE being enabled/disabled)
  // const { resolvedQuery, wasResolved } = resolveAmbiguousPronouns(cleanedQuery, chatHistory);
  // const baseQuery = wasResolved ? resolvedQuery : cleanedQuery;

  // Stage D: Query Context Expansion & HyDE
  const { hydeText, expandedQuery } = await generateHyDEAndExpandQuery(
    cleanedQuery,
    chatHistory,
    opts,
  );

  const denseQuery = hydeText && hydeText.length > 0 ? expandedQuery : cleanedQuery;
  const sparseQuery = cleanedQuery;

  // Stage E, F, G: Dual Query Representations (Executed Concurrently)
  const [denseVector, sparseVector] = await Promise.all([
    generateEmbeddings(denseQuery, { ...opts, operation: "dense_embedding" }),
    Promise.resolve(generateSparseVector(sparseQuery)),
  ]);

  // Stage H, I, J, K: Multi-Tenant Qdrant Hybrid Search & Reciprocal Rank Fusion (RRF)
  const allowedPageTypes = INTENT_PAGE_TYPE_FILTER[intent] ?? [];
  const rrfCandidates = await executeHybridSearch(
    collectionName,
    denseVector,
    sparseVector,
    allowedPageTypes,
  );

  if (!rrfCandidates || rrfCandidates.length === 0) {
    return { searchResults: [], resolvedParentChunks: [], hydeText };
  }

  // Stage L, M, N: 2nd-Stage Cohere/BGE Reranker (> 0.75 threshold -> Top 5 Chunks)
  const top5SelectedChunks = await rerankCandidates(
    sparseQuery,
    rrfCandidates,
    opts,
  );

  // Stage O: Resolve matched Child Chunks to broader Parent Chunks
  const parentMap = new Map();
  const resolvedParentChunks = [];

  top5SelectedChunks.forEach((childPoint) => {
    const payload = childPoint.payload || {};
    const parentId = payload.parentId || childPoint.id;
    const parentText =
      payload.parentText || payload.contextualText || payload.text;

    if (!parentMap.has(parentId)) {
      parentMap.set(parentId, true);
      resolvedParentChunks.push({
        ...childPoint,
        payload: {
          ...payload,
          text: parentText, // Expanded 850-token parent text used for LLM context synthesis
        },
      });
    }
  });

  console.log(
    `✨ [Stage O: Child -> Parent Resolution] Resolved ${top5SelectedChunks.length} child chunks -> ${resolvedParentChunks.length} unique parent chunks`,
  );

  return {
    searchResults: top5SelectedChunks,
    resolvedParentChunks,
    hydeText,
  };
}

module.exports = { executeRetrievalPipeline };
