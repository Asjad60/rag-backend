const { normalizePage } = require("./ingestion/normalizer");
const { checkQualityGates } = require("./ingestion/qualityGate");
const {
  generateContextualSummary,
} = require("./ingestion/contextualSummarizer");
const { parseDocumentStructure } = require("./ingestion/structureParser");
const { createParentChildChunks } = require("./ingestion/tokenSplitter");
const { vectorizeChunks } = require("./ingestion/vectorEngine");

/**
 * Full RAG Ingestion Pipeline — Stages B through L.
 */
async function processPageForIngestion(rawInput, url = "", options = {}) {
  console.log(
    `\n🚀 [Ingestion Flow] Starting processing for: ${url || "Raw Input"}`,
  );

  // Stage B: Page Normalization & Metadata Extraction
  const normalized = normalizePage(rawInput, url);
  console.log(
    `  ├─ Stage B (Normalized): "${normalized.pageTitle}" | type=${normalized.pageType} | words=${normalized.metrics.wordCount}`,
  );

  // Stage C: Quality Gates
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

  // Stages E & F: Contextual Summary & Document Structure
  const [contextualSummary, structures] = await Promise.all([
    generateContextualSummary(normalized, options),
    Promise.resolve(parseDocumentStructure(normalized.rawText)),
  ]);
  console.log(
    `  ├─ Stage E (Contextual Summary): "${contextualSummary.slice(0, 80)}..."`,
  );
  console.log(
    `  ├─ Stage F (Structure): ${structures.length} structural blocks`,
  );

  // Stages G & H: Token-Aware Parent-Child Chunking
  const pageMeta = {
    pageTitle: normalized.pageTitle,
    pageType: normalized.pageType,
    contactEmails: normalized.contactInfo.emails,
    contactPhones: normalized.contactInfo.phones,
    ecommerceMeta: normalized.ecommerceMeta,
    url,
  };

  const { parentChunks, childChunks } = createParentChildChunks(
    normalized.rawText,
    contextualSummary,
    pageMeta,
    structures,
  );
  console.log(
    `  ├─ Stage G-H (Parent-Child Chunks): ${parentChunks.length} Parents (850 tokens), ${childChunks.length} Children (180 tokens)`,
  );

  // Stages I–L: Dense Embedding + Native BM25 Sparse + Deterministic UUID
  const points = await vectorizeChunks(childChunks, url, options);
  console.log(
    `  └─ Stage I-L (Vectorized): ${points.length} Qdrant points (dense + native BM25 sparse)`,
  );

  return {
    skipped: false,
    pageTitle: normalized.pageTitle,
    pageType: normalized.pageType,
    normalizedText: normalized.rawText,
    url,
    contextualSummary,
    parentCount: parentChunks.length,
    childCount: childChunks.length,
    metrics: normalized.metrics,
    points,
  };
}

module.exports = { processPageForIngestion };
