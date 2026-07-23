const axios = require("axios");
const { callOpenRouterChat } = require("../llmService");
const { logLlmUsage } = require("../llmUsageService");

const RERANK_SCORE_THRESHOLD = 0.75;
const MAX_RERANKED_TOP_K = 3;

/* ============================================================================
 * COHERE RERANKER (COMMENTED OUT FOR REFERENCE AS REQUESTED)
 * To switch back to Cohere Rerank v3.5, uncomment this function and call cohereRerank()
 * inside rerankCandidates() below.
 * ============================================================================
async function cohereRerank(query, documents, options = {}) {
  const cohereApiKey = process.env.COHERE_API_KEY;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;

  if (cohereApiKey) {
    try {
      const response = await axios.post(
        "https://api.cohere.com/v2/rerank",
        {
          model: "rerank-v3.5",
          query,
          documents,
          top_n: Math.min(documents.length, 10),
        },
        {
          headers: {
            Authorization: `Bearer ${cohereApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 10_000,
        },
      );

      const results = response.data?.results || [];
      logLlmUsage({
        botId: options.botId,
        sessionId: options.sessionId,
        operation: "rerank",
        modelName: "cohere/rerank-v3.5",
      }).catch(() => {});

      return results.map((res) => ({
        index: res.index,
        relevanceScore: parseFloat(res.relevance_score.toFixed(4)),
      }));
    } catch (err) {
      console.warn("⚠️ Direct Cohere API rerank error:", err.message);
    }
  }

  if (openRouterApiKey) {
    try {
      const response = await axios.post(
        "https://openrouter.ai/api/v1/rerank",
        {
          model: "cohere/rerank-v3.5",
          query,
          documents,
          top_n: Math.min(documents.length, 10),
        },
        {
          headers: {
            Authorization: `Bearer ${openRouterApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 10_000,
        },
      );

      const results = response.data?.results || [];
      if (results.length > 0) {
        logLlmUsage({
          botId: options.botId,
          sessionId: options.sessionId,
          operation: "rerank",
          modelName: "cohere/rerank-v3.5",
        }).catch(() => {});

        return results.map((res) => ({
          index: res.index,
          relevanceScore: parseFloat(res.relevance_score.toFixed(4)),
        }));
      }
    } catch (_) {}
  }

  return null;
}
============================================================================ */

/**
 * 2nd-Stage Reranker using BAAI BGE Reranker (Open-Source, Free via Hugging Face Serverless API).
 * Performs precision joint Query-Document relevance scoring.
 */
async function bgeRerank(query, documents, options = {}) {
  const hfApiKey = process.env.HF_API_KEY || process.env.HF_TOKEN;

  if (hfApiKey) {
    try {
      const response = await axios.post(
        "https://router.huggingface.co/hf-inference/models/BAAI/bge-reranker-v2-m3",
        {
          inputs: documents.map((doc) => ({
            text: query,
            text_pair: doc,
          })),
        },
        {
          headers: {
            Authorization: `Bearer ${hfApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 10_000,
        },
      );
      console.log("Hugging  face  api call success");

      const rawData = response.data;
      const scores = Array.isArray(rawData[0]) ? rawData[0] : rawData;

      if (Array.isArray(scores) && scores.length > 0) {
        logLlmUsage({
          botId: options.botId,
          sessionId: options.sessionId,
          operation: "rerank",
          modelName: "BAAI/bge-reranker-v2-m3",
        }).catch(() => {});

        return scores.map((item, index) => {
          const score = typeof item === "number" ? item : (item.score ?? 0.5);
          return {
            index,
            relevanceScore: parseFloat(score.toFixed(4)),
          };
        });
      }
    } catch (err) {
      console.warn(
        "⚠️ HuggingFace BGE Reranker API error, falling back to OpenRouter Cross-Encoder:",
        err.message,
      );
    }
  }

  return null; // Fallback to OpenRouter Cross-Encoder scoring below
}

/**
 * Cross-Encoder Fallback Joint Query-Document Relevance Scorer.
 * Uses OpenRouter (openai/gpt-4o-mini) to rate candidate chunks on a 0.00 to 1.00 float scale.
 */
async function crossEncoderLLMScoring(query, candidateChunks, options = {}) {
  if (!candidateChunks || candidateChunks.length === 0) return [];

  const chunksText = candidateChunks
    .map(
      (c, i) => `[CHUNK ${i + 1}]:\n${(c.payload?.text || "").slice(0, 400)}`,
    )
    .join("\n\n---\n\n");

  const systemInstruction = `You are a precision Cross-Encoder 2nd-Stage Reranker.
Rate the direct relevance of each candidate chunk to the user query on a strict float scale from 0.00 to 1.00.
High scores (0.75 to 1.00) mean the chunk directly answers or provides facts for the query.
Low scores (< 0.50) mean the chunk is irrelevant or off-topic.

Reply ONLY with a JSON array of objects in this exact format:
[
  { "index": 0, "score": 0.85 },
  { "index": 1, "score": 0.30 }
]`;

  try {
    const raw = await callOpenRouterChat({
      messages: [
        { role: "system", content: systemInstruction },
        {
          role: "user",
          content: `Query: ${query}\n\nCandidate Chunks:\n${chunksText}`,
        },
      ],
      temperature: 0.0,
      maxTokens: 300,
      operation: "rerank",
      botId: options.botId,
      sessionId: options.sessionId,
    });

    const jsonStr = raw.replace(/```json|```/g, "").trim();
    const scores = JSON.parse(jsonStr);

    return candidateChunks.map((chunk, i) => {
      const match = scores.find((s) => s.index === i);
      return {
        ...chunk,
        relevanceScore: match
          ? parseFloat(match.score.toFixed(4))
          : chunk.score || 0.5,
      };
    });
  } catch (error) {
    console.warn(
      "⚠️ Cross-encoder scoring error, using vector/RRF scores:",
      error.message,
    );
    return candidateChunks.map((c) => ({
      ...c,
      relevanceScore: c.score || 0.8,
    }));
  }
}

/**
 * Stage L, M, N: 2nd-Stage Reranker & Selection.
 *
 * Scores joint Query-Document relevance using open-source BGE Reranker (BAAI/bge-reranker-v2-m3 via HuggingFace free API
 * or OpenRouter Cross-Encoder fallback), then filters chunks meeting the relevance score threshold (> 0.75) up to Top 5.
 *
 * @param {string}  query            - User query or HyDE expanded query
 * @param {Array}   candidateChunks  - Candidates from RRF Hybrid Search
 * @param {object}  [options]        - { botId, sessionId }
 * @returns {Promise<Array>}         - Top 5 reranked candidate chunks
 */
async function rerankCandidates(query, candidateChunks, options = {}) {
  if (!candidateChunks || candidateChunks.length === 0) return [];

  const topCandidates = candidateChunks.slice(0, 10);
  const docTexts = topCandidates.map(
    (c) => c.payload?.contextualText || c.payload?.text || "",
  );

  // 1. Try Hugging Face Free BGE Reranker API
  const bgeScores = await bgeRerank(query, docTexts, options);

  let scoredCandidates = [];

  if (bgeScores && bgeScores.length > 0) {
    console.log(
      "🎯 [2nd-Stage BGE Reranker] BAAI/bge-reranker-v2-m3 (HuggingFace Free API) successfully evaluated candidate relevance",
    );
    scoredCandidates = bgeScores.map((res) => {
      const point = topCandidates[res.index];
      return {
        ...point,
        relevanceScore: res.relevanceScore,
      };
    });
  } else {
    console.log(
      "🎯 [2nd-Stage Reranker] Running OpenRouter Cross-Encoder Joint Relevance Scorer",
    );
    scoredCandidates = await crossEncoderLLMScoring(
      query,
      topCandidates,
      options,
    );
  }

  // Filter candidates matching threshold > 0.75
  let filtered = scoredCandidates.filter(
    (c) => c.relevanceScore >= RERANK_SCORE_THRESHOLD,
  );

  // Fallback: If no candidate passed 0.75 threshold, take top 3 highest scoring candidates
  if (filtered.length === 0) {
    console.log(
      `⚠️ [Reranker] No candidate exceeded score threshold ${RERANK_SCORE_THRESHOLD} — taking top candidates`,
    );
    filtered = [...scoredCandidates]
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 3);
  } else {
    filtered.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  const selectedTop5 = filtered.slice(0, MAX_RERANKED_TOP_K);
  console.log(
    `✅ [Reranker Selected] ${selectedTop5.length} chunks (Top score: ${selectedTop5[0]?.relevanceScore || 0})`,
  );

  return selectedTop5;
}

module.exports = { rerankCandidates, bgeRerank, RERANK_SCORE_THRESHOLD };
