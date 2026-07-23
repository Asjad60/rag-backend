const Bot = require("../models/Bot");
const mongoose = require("mongoose");
const { generateEmbeddings } = require("../services/embeddingService");
const {
  generateChatResponse,
  generateClarifyResponse,
  detectIntent,
  getRoutingBranch,
  augmentQuery,
  checkGuardrails,
} = require("../services/llmService");
const { detectAndPrepare } = require("../services/languageService");
const {
  structuredProductSearch,
} = require("../services/structuredSearchService");
const {
  logChatEvent,
  updateFeedback,
} = require("../services/analyticsService");
const { getCollectionName } = require("../services/scraperService");
const { executeRetrievalPipeline } = require("../services/retrievalService");
const { qdrantClient } = require("../config/db");

// ─── Intent → Page-Type filter map (Semantic RAG path) ───────────────────────
// Each bot's data lives in its own collection — no botId filter needed.
// This map only restricts which page types are searched within the collection.
const INTENT_PAGE_TYPE_FILTER = {
  contact: ["contact_page"],
  about: ["about_page", "homepage"],
  faq: ["faq_page"],
  navigation: [],
  general: [],
};

// ─── Helper: Semantic Search (Stage 3A) ──────────────────────────────────────

/**
 * Intent-aware vector similarity search on the bot's dedicated collection.
 * No botId payload filter — the collection itself isolates bot data.
 *
 * @param {string}   collectionName - Bot's Qdrant collection (bot_<botId>)
 * @param {number[]} queryVector    - 1536-dim query embedding
 * @param {string}   intent         - Detailed intent from detectIntent()
 * @returns {Promise<Array>}
 */
async function semanticSearch(collectionName, queryVector, intent) {
  const allowedPageTypes = INTENT_PAGE_TYPE_FILTER[intent] ?? [];

  // Build optional pageType filter (no botId filter needed)
  const filter =
    allowedPageTypes.length > 0
      ? { must: [{ key: "pageType", match: { any: allowedPageTypes } }] }
      : undefined;

  let results = [];
  try {
    results = await qdrantClient.search(collectionName, {
      vector: queryVector,
      limit: 10,
      filter,
      with_payload: true,
      score_threshold: 0.25,
    });

    // Fallback: if page-type filter returned nothing, search the full collection
    if (results.length === 0 && allowedPageTypes.length > 0) {
      console.log(
        `⚠️  [Semantic] No results for filter [${allowedPageTypes}] — retrying without filter`,
      );
      results = await qdrantClient.search(collectionName, {
        vector: queryVector,
        limit: 10,
        with_payload: true,
      });
    }

    console.log(`🔍 [Semantic] ${results.length} chunks — intent="${intent}"`);
  } catch (e) {
    const msg = e.message || "";
    if (msg.toLowerCase().includes("not found") || msg.includes("404")) {
      console.warn(
        `⚠️  Collection "${collectionName}" not found — bot may not be ingested yet`,
      );
    } else {
      console.error("❌ [Semantic] Qdrant error:", e.message);
    }
  }

  return results;
}

// ─── Helper: Build Context String (Stage 4) ───────────────────────────────────

/**
 * Converts Qdrant search results into a numbered RESULT block format.
 *
 * Each block has a clearly labeled "URL:" field on its own line so the LLM
 * can reliably find the real page URL. The URL is also already embedded in
 * the chunk text as markdown links (from the scraper's link preservation step).
 */
function buildContextText(searchResults) {
  if (!searchResults || searchResults.length === 0) return "";
  return searchResults
    .map((r, i) => {
      const {
        pageTitle,
        url,
        pageType,
        contactEmails,
        contactPhones,
        text,
        parentText,
        contextualText,
      } = r.payload;
      const contentToUse = parentText || contextualText || text;
      const lines = [
        `RESULT ${i + 1}:`,
        `Title: ${pageTitle || "Page"}`,
        `URL: ${url}`,
        `Type: ${pageType}`,
      ];
      if (contactEmails?.length)
        lines.push(`Emails: ${contactEmails.join(", ")}`);
      if (contactPhones?.length)
        lines.push(`Phones: ${contactPhones.join(", ")}`);
      lines.push(""); // blank separator before content
      lines.push(contentToUse);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

exports.chat = async (req, res) => {
  try {
    const { botId, message, chatHistory = [], sessionId = "" } = req.body;

    // ── Validation ───────────────────────────────────────────────────────────
    if (!botId || !mongoose.isValidObjectId(botId)) {
      return res.status(400).json({ message: "Invalid or missing botId" });
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        message: "message is required and must be a non-empty string",
      });
    }

    const bot = await Bot.findById(botId);
    if (!bot) return res.status(404).json({ message: "Bot not found" });

    // Per-bot Qdrant collection (isolated, no cross-contamination)
    const collectionName = getCollectionName(botId);

    const botMeta = {
      businessName: bot.businessName,
      websiteUrl: bot.websiteUrl,
      welcomeMessage: bot.welcomeMessage,
      systemPrompt: bot.systemPrompt || "",
    };

    const opts = { botId, sessionId };

    // ── Stage 1: Language Detection + Query Translation ───────────────────────
    const { detectedLang, langName, isNonEnglish, translatedQuery } =
      await detectAndPrepare(message, opts);
    const queryForRetrieval = translatedQuery;

    // ── Stage 2: Intent Router ────────────────────────────────────────────────
    const intent = await detectIntent(queryForRetrieval, opts);
    const branch = getRoutingBranch(intent);
    console.log(
      `🔀 [Router] intent="${intent}" → branch="${branch}" | lang="${detectedLang}"`,
    );

    // ── Branch: Greeting ──────────────────────────────────────────────────────
    if (branch === "greeting") {
      let reply =
        bot.welcomeMessage ||
        `Hi! I'm the AI assistant for ${bot.businessName || "this website"}. How can I help you today?`;
      if (isNonEnglish) {
        reply = await generateChatResponse(
          botMeta,
          `System Instruction: Translate the following greeting to ${langName} and return ONLY the translation:\n\n${reply}`,
          [],
          "greeting",
          langName,
          opts
        );
      }
      logChatEvent({
        botId,
        sessionId,
        detectedLang,
        isNonEnglish,
        intent,
        ragPath: "greeting",
        queryText: message,
        translatedQuery: queryForRetrieval,
        replyText: reply,
        chunksRetrieved: 0,
        guardrailFired: false,
      });
      return res.json({ reply, intent, detectedLang });
    }

    // ── Stage 5 (pre-LLM): Guardrails ────────────────────────────────────────
    const guardrail = checkGuardrails(message);
    if (guardrail.fired) {
      let reply = `I'm here to help with questions about ${bot.businessName || "this website"}. How can I assist you today?`;
      if (isNonEnglish) {
        reply = await generateChatResponse(
          botMeta,
          `System Instruction: Translate the following text to ${langName} and return ONLY the translation:\n\n${reply}`,
          [],
          "general",
          langName,
          opts
        );
      }
      console.warn(
        `🛡️  [Guardrail] Fired (${guardrail.reason}) for bot=${botId}`,
      );
      logChatEvent({
        botId,
        sessionId,
        detectedLang,
        isNonEnglish,
        intent,
        ragPath: "none",
        queryText: message,
        translatedQuery: queryForRetrieval,
        replyText: reply,
        chunksRetrieved: 0,
        guardrailFired: true,
      });
      return res.json({ reply, intent, detectedLang });
    }

    // ── Branch: Clarify (Stage 3C) ─────────────────────────────────────────
    if (branch === "clarify") {
      const reply = await generateClarifyResponse(botMeta, message, langName, opts);
      logChatEvent({
        botId,
        sessionId,
        detectedLang,
        isNonEnglish,
        intent,
        ragPath: "clarify",
        queryText: message,
        translatedQuery: queryForRetrieval,
        replyText: reply,
        chunksRetrieved: 0,
        guardrailFired: false,
      });
      return res.json({ reply, intent, detectedLang });
    }

    // ── Execute Advanced RAG Retrieval Pipeline (HyDE + RRF + Cohere Reranker + Parent Resolution)
    const { searchResults, resolvedParentChunks } =
      await executeRetrievalPipeline(
        botId,
        queryForRetrieval,
        chatHistory,
        intent,
        opts
      );

    const ragPath = branch === "product" ? "structured" : "semantic";

    // ── Stage 4: Combine Parent Context ─────────────────────────────────────
    const contextText = buildContextText(
      resolvedParentChunks.length > 0 ? resolvedParentChunks : searchResults,
    );
    const chunksRetrieved = resolvedParentChunks.length;

    // ── Stage 5: LLM Generation (Grounded) ────────────────────────────────
    const fullHistory = [...chatHistory, { role: "user", content: message }];
    const reply = await generateChatResponse(
      botMeta,
      contextText,
      fullHistory,
      intent,
      langName,
      opts
    );

    // ── Stage 6: Analytics Log ─────────────────────────────────────────────
    const logId = await logChatEvent({
      botId,
      sessionId,
      detectedLang,
      isNonEnglish,
      intent,
      ragPath,
      queryText: message,
      translatedQuery: queryForRetrieval,
      replyText: reply,
      chunksRetrieved,
      guardrailFired: false,
    });

    return res.json({ reply, intent, detectedLang, ...(logId && { logId }) });
  } catch (error) {
    console.error("❌ Chat error:", error);
    res.status(500).json({ message: "Chat error", error: error.message });
  }
};

// ─── Feedback Handler ─────────────────────────────────────────────────────────

/**
 * POST /api/chat/feedback
 * Records thumbs up/down on a previous chat reply.
 * Request: { logId, thumbs: 'up' | 'down' }
 */
exports.chatFeedback = async (req, res) => {
  try {
    const { logId, thumbs } = req.body;

    if (!logId || !["up", "down"].includes(thumbs)) {
      return res
        .status(400)
        .json({ message: 'logId and thumbs ("up" or "down") are required' });
    }
    if (!mongoose.isValidObjectId(logId)) {
      return res.status(400).json({ message: "Invalid logId format" });
    }

    const log = await updateFeedback(logId, thumbs);
    if (!log)
      return res.status(404).json({ message: "Analytics log not found" });

    res.json({ message: "Feedback recorded", logId: log._id });
  } catch (error) {
    console.error("❌ Feedback error:", error);
    res.status(500).json({ message: error.message });
  }
};
