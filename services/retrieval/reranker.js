const axios = require("axios");
const { callOpenRouterChat } = require("../llmService");
const { logLlmUsage } = require("../llmUsageService");

const RERANK_SCORE_THRESHOLD = 0.1;
const CONFIDENCE_ABSTENTION_THRESHOLD = 0.05;
const MAX_RERANKED_TOP_K = 5;

/* ============================================================================
 * COHERE RERANKER
 * ============================================================================ */
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
          timeout: 3500,
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
          timeout: 3500,
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

/**
 * 2nd-Stage Reranker using Jina AI Reranker (Default: jina-reranker-v3).
 * Performs high-precision joint Query-Document relevance scoring.
 */
async function jinaRerank(query, documents, options = {}) {
  const rawApiKey = process.env.JINA_API_KEY || "";
  const jinaApiKey = rawApiKey.split("#")[0].trim();
  const rawModel = process.env.JINA_RERANK_MODEL || "jina-reranker-v3";
  const modelName = rawModel.split("#")[0].trim();

  if (jinaApiKey) {
    try {
      const response = await axios.post(
        "https://api.jina.ai/v1/rerank",
        {
          model: modelName,
          query,
          documents,
          top_n: Math.min(documents.length, 10),
        },
        {
          headers: {
            Authorization: `Bearer ${jinaApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 5000,
        },
      );

      const results = response.data?.results || [];
      if (Array.isArray(results) && results.length > 0) {
        logLlmUsage({
          botId: options.botId,
          sessionId: options.sessionId,
          operation: "rerank",
          modelName: `jina/${modelName}`,
        }).catch(() => {});

        return results.map((res) => {
          let scoreVal = Number(res.relevance_score);
          // Apply Sigmoid calibration if raw logit scores are returned (e.g. jina-reranker-v3)
          if (modelName.includes("v3") || scoreVal < 0 || scoreVal > 1) {
            scoreVal = 1.0 / (1.0 + Math.exp(-scoreVal));
          }
          return {
            index: res.index,
            relevanceScore: parseFloat(scoreVal.toFixed(4)),
          };
        });
      }
    } catch (err) {
      console.warn("⚠️ Direct Jina AI API rerank error:", err.message);
    }
  }

  return null;
}

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
          timeout: 3500,
        },
      );

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
          let hfScore = 0.5;
          if (typeof item === "number") {
            hfScore = item;
          } else if (item && typeof item === "object") {
            hfScore = typeof item.score === "number" ? item.score : 0.5;
          }

          // Bound hfScore to prevent log(0) / infinity
          const safeScore = Math.max(Math.min(hfScore, 0.999999), 1e-10);
          // Reconstruct raw BGE-Reranker logit z = ln(s / (1 - s))
          const logit = Math.log(safeScore / (1 - safeScore));
          // Calibrate BGE-v2-m3 logits onto standard 0.0 - 1.0 relevance scale
          const calibratedScore = 1.0 / (1.0 + Math.exp(-(logit + 4.5) / 1.5));

          return {
            index,
            relevanceScore: parseFloat(calibratedScore.toFixed(4)),
          };
        });
      }
    } catch (err) {
      console.warn("⚠️ HuggingFace BGE Reranker API error:", err.message);
    }
  }

  return null;
}

/**
 * Cross-Encoder Fallback Joint Query-Document Relevance Scorer.
 * Uses OpenRouter (openai/gpt-4o-mini) to rate candidate chunks on a 0.00 to 1.00 float scale.
 */
async function crossEncoderLLMScoring(query, candidateChunks, options = {}) {
  if (!candidateChunks || candidateChunks.length === 0) return [];

  const queryForScoring = (query || "").split("\n\n")[0].trim();

  const chunksText = candidateChunks
    .map(
      (c, i) =>
        `[CHUNK ${i + 1} | Title: ${c.payload?.pageTitle || "Page"} | URL: ${c.payload?.url || ""}]:\n${(c.payload?.contextualText || c.payload?.text || "").slice(0, 1000)}`,
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
          content: `Query: ${queryForScoring}\n\nCandidate Chunks:\n${chunksText}`,
        },
      ],
      temperature: 0.0,
      maxTokens: 300,
      operation: "rerank",
      botId: options.botId,
      sessionId: options.sessionId,
    });
    console.log("🎯 [Cross-Encoder Raw Output]:", raw);

    const rawStr = typeof raw === "string" ? raw : String(raw || "");
    const matchJson = rawStr.match(/\[[\s\S]*\]/);
    const jsonStr = matchJson
      ? matchJson[0]
      : rawStr.replace(/```json|```/g, "").trim();
    const scores = JSON.parse(jsonStr);

    return candidateChunks.map((chunk, i) => {
      let scoreVal = 0.8;
      if (Array.isArray(scores)) {
        const match =
          scores.find(
            (s) =>
              typeof s === "object" &&
              s !== null &&
              (s.index === i ||
                s.index === i + 1 ||
                s.chunk === i ||
                s.chunk === i + 1 ||
                s.item === i ||
                s.item === i + 1),
          ) || scores[i];

        if (typeof match === "number") {
          scoreVal = match;
        } else if (match && typeof match.score === "number") {
          scoreVal = match.score;
        }
      }
      return {
        ...chunk,
        relevanceScore: parseFloat(Number(scoreVal).toFixed(4)),
      };
    });
  } catch (error) {
    console.warn(
      "⚠️ Cross-encoder scoring error, using vector/RRF scores:",
      error.message,
    );
    return candidateChunks.map((c) => ({
      ...c,
      relevanceScore: c.rrfScore ?? 0.8,
    }));
  }
}

/**
 * Stage L, M, N: 2nd-Stage Reranker & Selection.
 *
 * Scores joint Query-Document relevance using configured provider (Jina AI / BGE / Cohere via .env),
 * then filters chunks meeting the relevance score threshold (> 0.10) up to Top 5.
 *
 * @param {string}  query            - User query or HyDE expanded query
 * @param {Array}   candidateChunks  - Candidates from RRF Hybrid Search
 * @param {object}  [options]        - { botId, sessionId }
 * @returns {Promise<Array>}         - Top 5 reranked candidate chunks
 */
async function rerankCandidates(query, candidateChunks, options = {}) {
  if (!candidateChunks || candidateChunks.length === 0) return [];

  // Apply URL-level Diversity Filtering: max 2 child chunks per distinct page URL
  const parentCounts = new Map();
  const diverseCandidates = [];

  for (const candidate of candidateChunks) {
    const parentKey =
      candidate.payload?.url || candidate.payload?.parentId || candidate.id;
    const count = parentCounts.get(parentKey) || 0;
    if (count < 2) {
      parentCounts.set(parentKey, count + 1);
      diverseCandidates.push(candidate);
    }
  }

  const topCandidates = diverseCandidates.slice(0, 12);
  const docTexts = topCandidates.map(
    (c) => c.payload?.contextualText || c.payload?.text || "",
  );

  const rawProvider =
    process.env.RERANKER_PROVIDER || process.env.RERANK_PROVIDER || "jina";
  const provider = rawProvider.split("#")[0].trim().toLowerCase();
  console.log(
    `\n🔍 [2nd-Stage Reranker Initializing] Provider Config: "${provider.toUpperCase()}"`,
  );

  let rerankScores = null;
  let providerTag = "";

  if (provider === "none" || provider === "off" || provider === "disabled") {
    console.log(
      "ℹ️ [2nd-Stage Reranker Bypassed] RERANKER_PROVIDER is set to NONE. Using RRF Hybrid Search vector rankings directly.",
    );
    rerankScores = topCandidates.map((c, idx) => ({
      index: idx,
      relevanceScore: parseFloat(Math.max(0.85 - idx * 0.02, 0.7).toFixed(4)),
    }));
    providerTag = "RRF Vector Rankings (Reranker Disabled)";
  } else if (provider === "bge") {
    console.log(
      "🚀 [Executing Reranker Engine] BAAI BGE Reranker (BAAI/bge-reranker-v2-m3)...",
    );
    rerankScores = await bgeRerank(query, docTexts, options);
    providerTag = "BAAI BGE Reranker (BAAI/bge-reranker-v2-m3)";
  } else if (provider === "cohere") {
    console.log(
      "🚀 [Executing Reranker Engine] Cohere Rerank (rerank-v3.5)...",
    );
    rerankScores = await cohereRerank(query, docTexts, options);
    providerTag = "Cohere Rerank v3.5";
  } else {
    // Default: Jina AI Reranker
    const jinaModel = process.env.JINA_RERANK_MODEL || "jina-reranker-v3";
    console.log(
      `🚀 [Executing Reranker Engine] Jina AI Reranker (${jinaModel})...`,
    );
    rerankScores = await jinaRerank(query, docTexts, options);
    providerTag = `Jina AI Reranker (${jinaModel})`;

    // If Jina API wasn't configured or failed, fall back to BGE if HF_API_KEY exists
    if (!rerankScores && (process.env.HF_API_KEY || process.env.HF_TOKEN)) {
      console.log(
        "⚠️ [Jina AI Reranker Unreachable/Fallback] Falling back to BAAI BGE Reranker via HuggingFace API...",
      );
      rerankScores = await bgeRerank(query, docTexts, options);
      providerTag = "BAAI BGE Reranker (HF Fallback)";
    }
  }

  let scoredCandidates = [];

  if (rerankScores && rerankScores.length > 0) {
    console.log(
      `✅ [2nd-Stage Reranker SUCCESS] Active Engine: "${providerTag}" successfully evaluated ${rerankScores.length} candidate chunks`,
    );
    scoredCandidates = rerankScores.map((res) => {
      const point = topCandidates[res.index];
      return {
        ...point,
        relevanceScore: res.relevanceScore,
      };
    });
  } else {
    console.log(
      "⚠️ [2nd-Stage Reranker Fallback] Primary reranker unavailable. Running OpenRouter Cross-Encoder LLM Scorer...",
    );
    scoredCandidates = await crossEncoderLLMScoring(
      query,
      topCandidates,
      options,
    );
  }

  // Fallback: If top score is 0 or all scores are 0, fall back to RRF vector rankings
  const maxScore = Math.max(
    ...scoredCandidates.map((c) => c.relevanceScore || 0),
    0,
  );
  if (maxScore === 0) {
    console.log(
      "⚠️ [Reranker Fallback] Cross-Encoder scored all chunks 0.00. Preserving top RRF vector candidates for LLM context synthesis.",
    );
    scoredCandidates = topCandidates.map((c, idx) => ({
      ...c,
      relevanceScore: parseFloat(Math.max(0.85 - idx * 0.02, 0.75).toFixed(4)),
    }));
  }

  // Filter candidates matching threshold > 0.10
  let filtered = scoredCandidates.filter(
    (c) => c.relevanceScore >= RERANK_SCORE_THRESHOLD,
  );

  // Fallback: If no candidate passed threshold, take top 3 highest scoring candidates
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

module.exports = {
  rerankCandidates,
  jinaRerank,
  bgeRerank,
  cohereRerank,
  RERANK_SCORE_THRESHOLD,
  CONFIDENCE_ABSTENTION_THRESHOLD,
};
