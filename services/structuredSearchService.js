const { qdrantClient } = require('../config/db');

/**
 * Page types that indicate product/commerce-relevant content.
 * Used to restrict the Qdrant search to the most relevant pages
 * for product and pricing queries.
 */
const PRODUCT_PAGE_TYPES = ['product_page', 'pricing_page', 'service_page', 'homepage'];

/**
 * Stage 3B — Structured Search
 *
 * Runs a pageType-filtered vector similarity search on the bot's own
 * Qdrant collection.  No botId filter is needed because each bot has its
 * own isolated collection (bot_<botId>).
 *
 * Falls back to an unfiltered search over the full collection if no
 * product/pricing pages were scraped for this bot.
 *
 * @param {string}   collectionName - Bot's Qdrant collection (bot_<botId>)
 * @param {number[]} queryVector    - Pre-computed 3072-dim query embedding
 * @param {number}   [limit=6]     - Max chunks to return
 * @returns {Promise<Array>}        - Qdrant search result objects
 */
async function structuredProductSearch(collectionName, queryVector, limit = 6) {
  const productFilter = {
    must: [
      { key: 'pageType', match: { any: PRODUCT_PAGE_TYPES } },
    ],
  };

  try {
    let results = await qdrantClient.search(collectionName, {
      vector:          queryVector,
      limit,
      filter:          productFilter,
      with_payload:    true,
      score_threshold: 0.30,
    });

    if (results.length > 0) {
      console.log(`📦 [Structured] Found ${results.length} chunks on product/pricing pages`);
      return results;
    }

    // ── Fallback: search the entire collection without page-type filter ────
    console.log('⚠️  [Structured] No product-page results — falling back to full collection search');
    results = await qdrantClient.search(collectionName, {
      vector:          queryVector,
      limit,
      with_payload:    true,
      score_threshold: 0.20,
    });

    console.log(`📦 [Structured/Fallback] Found ${results.length} chunks`);
    return results;
  } catch (err) {
    // Collection may not exist if the bot has never been ingested
    const msg = err.message || '';
    if (msg.toLowerCase().includes('not found') || msg.includes('404')) {
      console.warn(`⚠️  [Structured] Collection "${collectionName}" not found — bot not ingested yet`);
    } else {
      console.error('❌ [Structured] Qdrant search error:', err.message);
    }
    return [];
  }
}

module.exports = { structuredProductSearch, PRODUCT_PAGE_TYPES };
