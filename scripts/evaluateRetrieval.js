/**
 * Retrieval Evaluation Harness CLI Tool
 *
 * Evaluates the retrieval pipeline against a golden query dataset.
 * Computes Recall@1, Recall@5, Mean Reciprocal Rank (MRR), and Abstention Accuracy.
 *
 * Usage:
 *   node backend/scripts/evaluateRetrieval.js [botId]
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { executeRetrievalPipeline } = require("../services/retrievalService");
const { generateSparseVector } = require("../services/ingestion/vectorEngine");

// Golden Test Query Benchmark Dataset
const GOLDEN_TEST_SUITE = [
  {
    id: "Q01",
    query: "What is the return policy?",
    intent: "general",
    expectedKeywords: ["return", "refund", "days", "policy"],
    shouldAbstain: false,
  },
  {
    id: "Q02",
    query: "Do you have sunscreen jackets under 2000 rupees?",
    intent: "product",
    expectedKeywords: ["jacket", "sunscreen", "price", "rupees"],
    shouldAbstain: false,
  },
  {
    id: "Q03",
    query: "How can I contact customer support team?",
    intent: "contact",
    expectedKeywords: ["contact", "email", "phone", "support"],
    shouldAbstain: false,
  },
  {
    id: "Q04",
    query: "What is the warranty on nuclear submarines?",
    intent: "general",
    expectedKeywords: [],
    shouldAbstain: true, // Out-of-domain query -> Should trigger confidence gate
  },
  {
    id: "Q05",
    query: "Tell me about quantum teleportation pricing",
    intent: "product",
    expectedKeywords: [],
    shouldAbstain: true, // Out-of-domain query -> Should trigger confidence gate
  },
];

/**
 * Runs the evaluation suite and prints a detailed report.
 */
async function runRetrievalEvaluation() {
  const botId = process.argv[2] || process.env.TEST_BOT_ID || "demo_bot";

  console.log("===============================================================");
  console.log(`🚀 [Retrieval Eval Harness] Evaluating pipeline for bot: ${botId}`);
  console.log("===============================================================\n");

  let totalQueries = GOLDEN_TEST_SUITE.length;
  let recallAt1Hits = 0;
  let recallAt5Hits = 0;
  let reciprocalRankSum = 0;
  let correctAbstentions = 0;
  let totalAbstentionTests = 0;

  const resultsTable = [];

  for (const item of GOLDEN_TEST_SUITE) {
    try {
      const startTime = Date.now();
      const res = await executeRetrievalPipeline(botId, item.query, [], item.intent, {
        botId,
        sessionId: "eval_harness",
      });
      const latencyMs = Date.now() - startTime;

      const isAbstained = Boolean(res.isAbstained);
      const chunks = res.searchResults || [];
      const topScore = res.topRelevanceScore || (chunks[0]?.relevanceScore ?? 0);

      let foundRank = -1;

      if (item.shouldAbstain) {
        totalAbstentionTests++;
        if (isAbstained) {
          correctAbstentions++;
        }
      } else if (!isAbstained && chunks.length > 0) {
        // Check rank of first chunk containing expected keywords
        for (let i = 0; i < chunks.length; i++) {
          const chunkText = (chunks[i].payload?.text || "").toLowerCase();
          const match = item.expectedKeywords.some((kw) => chunkText.includes(kw.toLowerCase()));
          if (match) {
            foundRank = i + 1;
            break;
          }
        }
      }

      if (foundRank === 1) recallAt1Hits++;
      if (foundRank > 0 && foundRank <= 5) recallAt5Hits++;
      if (foundRank > 0) reciprocalRankSum += 1 / foundRank;

      resultsTable.push({
        ID: item.id,
        Query: item.query.slice(0, 35),
        Abstained: isAbstained ? "YES (Gate)" : "NO",
        TopScore: topScore.toFixed(3),
        Rank: foundRank > 0 ? `#${foundRank}` : isAbstained ? "N/A" : "MISS",
        Latency: `${latencyMs}ms`,
      });
    } catch (err) {
      console.warn(`⚠️ Error evaluating query "${item.query}":`, err.message);
      resultsTable.push({
        ID: item.id,
        Query: item.query.slice(0, 35),
        Abstained: "ERROR",
        TopScore: "0.000",
        Rank: "ERR",
        Latency: "N/A",
      });
    }
  }

  console.table(resultsTable);

  const inDomainCount = totalQueries - totalAbstentionTests;
  const recallAt1 = inDomainCount > 0 ? ((recallAt1Hits / inDomainCount) * 100).toFixed(1) : "0.0";
  const recallAt5 = inDomainCount > 0 ? ((recallAt5Hits / inDomainCount) * 100).toFixed(1) : "0.0";
  const mrr = inDomainCount > 0 ? (reciprocalRankSum / inDomainCount).toFixed(3) : "0.000";
  const abstentionAccuracy = totalAbstentionTests > 0 ? ((correctAbstentions / totalAbstentionTests) * 100).toFixed(1) : "N/A";

  console.log("\n===============================================================");
  console.log("📊 FINAL RETRIEVAL EVALUATION METRICS");
  console.log("===============================================================");
  console.log(`• Total Benchmark Queries evaluated : ${totalQueries}`);
  console.log(`• Recall@1                          : ${recallAt1}%`);
  console.log(`• Recall@5                          : ${recallAt5}%`);
  console.log(`• Mean Reciprocal Rank (MRR)       : ${mrr}`);
  console.log(`• Abstention Gate Accuracy         : ${abstentionAccuracy}% (${correctAbstentions}/${totalAbstentionTests} unanswerable blocked)`);
  console.log("===============================================================\n");
}

// Unit test check for BM25 Sparse Vector generator
function testSparseVectorEngine() {
  console.log("🧪 Testing BM25 Sparse Vector Generator...");
  const sampleText = "The quick brown fox jumps over the lazy dog in Sunscreen Jacket Ice Pro";
  const vec = generateSparseVector(sampleText);
  console.log(`  ✓ Tokens hashed : ${vec.indices.length} unique indices`);
  console.log(`  ✓ Sample values  :`, vec.values.slice(0, 5));
  console.assert(vec.indices.length === vec.values.length, "Indices and values count mismatch");
  console.log("  ✓ Sparse vector structure valid { indices, values }\n");
}

if (require.main === module) {
  testSparseVectorEngine();
  runRetrievalEvaluation().catch(console.error);
}

module.exports = { runRetrievalEvaluation, GOLDEN_TEST_SUITE };
