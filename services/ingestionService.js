const { normalizePage } = require('./ingestion/normalizer');
const { checkQualityGates } = require('./ingestion/qualityGate');
const { generateContextualSummary } = require('./ingestion/contextualSummarizer');
const { parseDocumentStructure } = require('./ingestion/structureParser');
const { createParentChildChunks } = require('./ingestion/tokenSplitter');
const { vectorizeChunks } = require('./ingestion/vectorEngine');

/**
 * Executes the complete RAG Ingestion Flow (Stages A through L).
 *
 * @param {string} rawInput - Raw HTML or Markdown page content
 * @param {string} url      - Page URL
 * @returns {Promise<object>}
 */
async function processPageForIngestion(rawInput, url = '', options = {}) {
  console.log(`\n🚀 [Ingestion Flow] Starting processing for: ${url || 'Raw Input'}`);

  // Stage B: Page Normalization & Metadata Extraction
  const normalized = normalizePage(rawInput, url);
  console.log(`  ├─ Stage B (Normalized): "${normalized.pageTitle}" | type=${normalized.pageType} | words=${normalized.metrics.wordCount}`);

  // Stage C: Quality Gates (Pass/Fail Checks)
  const quality = checkQualityGates(normalized);
  if (!quality.pass) {
    console.warn(`  └─ 🛑 Stage C (Quality Gate FAIL): ${quality.reason}`);
    return {
      skipped: true,
      skipReason: quality.reason,
      pageTitle: normalized.pageTitle,
      url,
      metrics: normalized.metrics,
      points: [],
    };
  }
  console.log(`  ├─ Stage C (Quality Gate PASS): Text quality verified`);

  // Stage E & F: Contextual Summary & Document Structure (Executed in Parallel)
  const [contextualSummary, structures] = await Promise.all([
    generateContextualSummary(normalized, options),
    Promise.resolve(parseDocumentStructure(normalized.rawText)),
  ]);
  console.log(`  ├─ Stage E (Contextual Summary): "${contextualSummary.slice(0, 80)}..."`);
  console.log(`  ├─ Stage F (Structure Parsed): ${structures.length} structural blocks detected`);

  // Stage G & H: Token-Aware Splitter & Parent-Child Chunk Creation
  const pageMeta = {
    pageTitle: normalized.pageTitle,
    pageType: normalized.pageType,
    contactEmails: normalized.contactInfo.emails,
    contactPhones: normalized.contactInfo.phones,
    url,
  };

  const { parentChunks, childChunks } = createParentChildChunks(
    normalized.rawText,
    contextualSummary,
    pageMeta
  );
  console.log(`  ├─ Stage G & H (Parent-Child Chunks): ${parentChunks.length} Parents (850 tokens), ${childChunks.length} Children (180 tokens)`);

  // Stage I, J, K, L: Vectorization Engine (1536-dim Dense + BM25 Sparse + Deterministic UUIDs)
  const points = await vectorizeChunks(childChunks, url, options);
  console.log(`  └─ Stage I-L (Vectorized): ${points.length} Qdrant points generated with deterministic SHA-256 UUIDs`);

  return {
    skipped: false,
    pageTitle: normalized.pageTitle,
    pageType: normalized.pageType,
    url,
    contextualSummary,
    parentCount: parentChunks.length,
    childCount: childChunks.length,
    metrics: normalized.metrics,
    points,
  };
}

module.exports = { processPageForIngestion };
