const { generateHyDEAndExpandQuery, resolveAmbiguousPronouns } = require("./retrieval/hydeService");
const { executeHybridSearch } = require("./retrieval/hybridSearch");
const { rerankCandidates } = require("./retrieval/reranker");
const { generateEmbeddings } = require("./embeddingService");
const { generateSparseVector } = require("./ingestion/vectorEngine");
const { getCollectionName } = require("./scraperService");
const { parseEcommerceQuery } = require("./retrieval/ecommerceQueryParser");

const INTENT_PAGE_TYPE_FILTER = {
  product: ["product_page", "pricing_page", "service_page", "homepage"],
  contact: ["contact_page"],
  about: ["about_page", "homepage"],
  faq: ["faq_page"],
  navigation: [],
  general: [],
};

/**
 * Stage D through O: Advanced Visitor Query Retrieval Pipeline with E-Commerce & Comparison Support.
 *
 * Pipeline Flow:
 *   1. Stage D: E-Commerce Query Parsing (Zero-cost fast RegEx / LLM constraint extraction)
 *   2. Stage D2: Query Context Expansion & HyDE
 *   3. Stage E-G: Dual Query Representations (1536-dim Dense + BM25 Sparse)
 *   4. Stage H-K: Qdrant Multi-Tenant Search with Numeric Price Filters & Balanced Comparison Retrieval
 *   5. Stage L-N: 2nd-Stage Cohere Reranker (> 0.75 threshold) -> Top 5 Chunks
 *   6. Stage O: Resolve Matched Child Chunks to broader Parent Chunks
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

  // Stage D-pre: Resolve pronouns & implicit follow-up subjects (e.g. "give me the link" -> "Sunscreen Jacket Ice Pro give me the link")
  const { resolvedQuery, wasResolved } = await resolveAmbiguousPronouns(cleanedQuery, chatHistory, opts);
  const baseQuery = wasResolved ? resolvedQuery : cleanedQuery;

  // Stage D0: E-Commerce Attribute & Comparison Parsing
  const ecomConstraints = await parseEcommerceQuery(baseQuery, opts);

  // Construct Qdrant extra payload filters (e.g. priceNumeric range)
  let extraFilter = null;
  if (ecomConstraints.maxPrice !== null) {
    extraFilter = { key: "priceNumeric", range: { lte: ecomConstraints.maxPrice } };
    console.log(`🏷️ [Qdrant Payload Filter] Applying price filter: priceNumeric <= ${ecomConstraints.maxPrice}`);
  }

  const targetSearchQuery = ecomConstraints.cleanSearchQuery || baseQuery;

  // Stage D: Query Context Expansion & HyDE
  const { hydeText, expandedQuery } = await generateHyDEAndExpandQuery(
    targetSearchQuery,
    chatHistory,
    opts,
  );

  const denseQuery = hydeText && hydeText.length > 0 ? expandedQuery : targetSearchQuery;
  const sparseQuery = targetSearchQuery;

  const allowedPageTypes = INTENT_PAGE_TYPE_FILTER[intent] ?? [];
  let rrfCandidates = [];

  // Stage H-K: Multi-Product Comparison Retrieval (Decomposes "Product A vs Product B" into balanced sub-searches)
  if (ecomConstraints.isComparison && ecomConstraints.comparisonEntities.length >= 2) {
    console.log(`🔀 [Comparison Retrieval] Multi-entity comparison detected for: "${ecomConstraints.comparisonEntities.join(" vs ")}"`);
    
    // Execute balanced sub-retrievals for each compared entity concurrently
    const subSearchResults = await Promise.all(
      ecomConstraints.comparisonEntities.map(async (entity) => {
        const subQuery = `${entity} product description price specs features`;
        const [dVec, sVec] = await Promise.all([
          generateEmbeddings(subQuery, { ...opts, operation: "dense_embedding" }),
          Promise.resolve(generateSparseVector(entity)),
        ]);
        return executeHybridSearch(collectionName, dVec, sVec, allowedPageTypes, extraFilter);
      })
    );

    // Interleave candidate chunks to guarantee balanced context for both products
    const candidateMap = new Map();
    const maxLength = Math.max(...subSearchResults.map(r => r.length));
    for (let i = 0; i < maxLength; i++) {
      for (let j = 0; j < subSearchResults.length; j++) {
        const item = subSearchResults[j][i];
        if (item && !candidateMap.has(item.id)) {
          candidateMap.set(item.id, item);
        }
      }
    }
    rrfCandidates = Array.from(candidateMap.values());
    console.log(`🔀 [Comparison Retrieval] Interleaved ${rrfCandidates.length} balanced candidates across ${ecomConstraints.comparisonEntities.length} entities`);
  } else {
    // Standard Single-Query Hybrid Search
    const [denseVector, sparseVector] = await Promise.all([
      generateEmbeddings(denseQuery, { ...opts, operation: "dense_embedding" }),
      Promise.resolve(generateSparseVector(sparseQuery)),
    ]);

    rrfCandidates = await executeHybridSearch(
      collectionName,
      denseVector,
      sparseVector,
      allowedPageTypes,
      extraFilter,
    );
  }

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
