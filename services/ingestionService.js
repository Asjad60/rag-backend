const { normalizePage }             = require('./ingestion/normalizer');
const { checkQualityGates }         = require('./ingestion/qualityGate');
const { generateContextualSummary } = require('./ingestion/contextualSummarizer');
const { parseDocumentStructure }    = require('./ingestion/structureParser');
const { createParentChildChunks }   = require('./ingestion/tokenSplitter');
const { vectorizeChunks }           = require('./ingestion/vectorEngine');

/**
 * Stages B–H: Normalize, quality-gate, and chunk a raw page.
 *
 * Does NOT vectorize. Returns the raw chunk objects so the caller can
 * accumulate corpus statistics across all pages before vectorizing
 * (required for true BM25 IDF computation).
 *
 * @param {string} rawInput - Raw HTML or Markdown page content
 * @param {string} url      - Page URL
 * @param {object} options  - { botId }
 * @returns {Promise<object>}
 *   On success: { skipped:false, pageTitle, pageType, normalizedText, url,
 *                 contextualSummary, parentChunks, childChunks, metrics }
 *   On skip:    { skipped:true,  skipReason, pageTitle, url, metrics,
 *                 childChunks:[], parentChunks:[] }
 */
async function processPageForChunks(rawInput, url = '', options = {}) {
  // Stage B: Page Normalization & Metadata Extraction
  const normalized = normalizePage(rawInput, url);

  // Stage C: Quality Gates (Pass/Fail Checks)
  const quality = checkQualityGates(normalized);
  if (!quality.pass) {
    return {
      skipped:      true,
      skipReason:   quality.reason,
      pageTitle:    normalized.pageTitle,
      url,
      metrics:      normalized.metrics,
      childChunks:  [],
      parentChunks: [],
    };
  }

  // Stages E & F: Contextual Summary & Document Structure (parallel)
  const [contextualSummary, structures] = await Promise.all([
    generateContextualSummary(normalized, options),
    Promise.resolve(parseDocumentStructure(normalized.rawText)),
  ]);

  // Stages G & H: Token-Aware Parent-Child Chunking
  const pageMeta = {
    pageTitle:     normalized.pageTitle,
    pageType:      normalized.pageType,
    contactEmails: normalized.contactInfo.emails,
    contactPhones: normalized.contactInfo.phones,
    ecommerceMeta: normalized.ecommerceMeta,
    url,
  };

  const { parentChunks, childChunks } = createParentChildChunks(
    normalized.rawText,
    contextualSummary,
    pageMeta,
  );

  return {
    skipped:         false,
    pageTitle:       normalized.pageTitle,
    pageType:        normalized.pageType,
    normalizedText:  normalized.rawText,
    url,
    contextualSummary,
    parentChunks,
    childChunks,
    metrics:         normalized.metrics,
    structures,
  };
}

/**
 * Stages I–L: Vectorize pre-computed chunks using BM25 corpus statistics.
 *
 * Separated from processPageForChunks so the caller can build the full
 * corpus statistics (from ALL pages) before calling this, ensuring that
 * IDF values are computed against the complete corpus — not just a single page.
 *
 * @param {object[]}    childChunks  - Chunk objects from processPageForChunks
 * @param {string}      url          - Page URL
 * @param {object|null} corpusStats  - BM25 stats ({ totalChunks, totalTokens, termDf })
 * @param {object}      [options]    - { botId }
 * @returns {Promise<object[]>}      - Qdrant point objects
 */
async function vectorizePageChunks(childChunks, url, corpusStats = null, options = {}) {
  return vectorizeChunks(childChunks, url, corpusStats, options);
}

/**
 * Executes the complete RAG Ingestion Flow (Stages B through L) in a single call.
 *
 * Kept for backward compatibility and single-page use cases.
 * For batch ingestion over multiple pages, prefer the two-phase pattern:
 *   1. processPageForChunks()  (all pages)
 *   2. vectorizePageChunks()   (with full corpus stats)
 *
 * @param {string}      rawInput    - Raw HTML or Markdown page content
 * @param {string}      url         - Page URL
 * @param {object}      options     - { botId }
 * @param {object|null} corpusStats - Optional BM25 corpus stats (null → TF-only fallback)
 * @returns {Promise<object>}
 */
async function processPageForIngestion(rawInput, url = '', options = {}, corpusStats = null) {
  console.log(`\n🚀 [Ingestion Flow] Starting processing for: ${url || 'Raw Input'}`);

  const chunksResult = await processPageForChunks(rawInput, url, options);

  if (chunksResult.skipped) {
    console.warn(`  └─ 🛑 Stage C (Quality Gate FAIL): ${chunksResult.skipReason}`);
    return { ...chunksResult, points: [] };
  }

  console.log(`  ├─ Stage B (Normalized): "${chunksResult.pageTitle}" | type=${chunksResult.pageType} | words=${chunksResult.metrics.wordCount}`);
  console.log(`  ├─ Stage C (Quality Gate PASS): Text quality verified`);
  console.log(`  ├─ Stage E (Contextual Summary): "${chunksResult.contextualSummary.slice(0, 80)}..."`);
  console.log(`  ├─ Stage G-H (Parent-Child Chunks): ${chunksResult.parentChunks.length} Parents (850 tokens), ${chunksResult.childChunks.length} Children (180 tokens)`);

  // Stages I–L: Vectorization with BM25 corpus stats
  const points = await vectorizeChunks(chunksResult.childChunks, url, corpusStats, options);
  console.log(`  └─ Stage I-L (Vectorized): ${points.length} Qdrant points generated with deterministic SHA-256 UUIDs`);

  return {
    skipped:          false,
    pageTitle:        chunksResult.pageTitle,
    pageType:         chunksResult.pageType,
    normalizedText:   chunksResult.normalizedText,
    url,
    contextualSummary: chunksResult.contextualSummary,
    parentCount:      chunksResult.parentChunks.length,
    childCount:       chunksResult.childChunks.length,
    metrics:          chunksResult.metrics,
    points,
  };
}

module.exports = {
  processPageForChunks,
  vectorizePageChunks,
  processPageForIngestion,
};
