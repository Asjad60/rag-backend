const Bot = require("../models/Bot");
const mongoose = require("mongoose");
const {
  generateChatResponse,
  generateClarifyResponse,
  detectIntent,
  getRoutingBranch,
  checkGuardrails,
} = require("../services/llmService");
const { detectAndPrepare } = require("../services/languageService");
const {
  logChatEvent,
  updateFeedback,
} = require("../services/analyticsService");
const { executeRetrievalPipeline } = require("../services/retrievalService");

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
  const topResults = searchResults.slice(0, 3);
  let context = topResults
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

  if (context.length > 6000) {
    context = context.slice(0, 6000) + "\n...[truncated]";
  }
  return context;
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
      let reply = "";
      const textToMatch = (queryForRetrieval || message)
        .toLowerCase()
        .replace(/[,!?.']/g, " ")
        .trim();

      if (/thanks|thank you|thx|appreciate|thank/i.test(textToMatch)) {
        reply = `You're very welcome! Let me know if there's anything else I can help you with regarding ${bot.businessName || "our website"}.`;
      } else if (/bye|goodbye|see ya|cya|farewell/i.test(textToMatch)) {
        reply = `Goodbye! Have a great day!`;
      } else if (/whats up|what's up|sup|what up/i.test(textToMatch)) {
        reply = `Not much! I'm here to help you with any questions about ${bot.businessName || "this website"}. What can I help you find today?`;
      } else if (/how are you|how's it going|how do you do/i.test(textToMatch)) {
        reply = `I'm doing great, thank you! How can I assist you with ${bot.businessName || "this website"} today?`;
      } else {
        reply =
          bot.welcomeMessage ||
          `Hi! I'm the AI assistant for ${bot.businessName || "this website"}. How can I help you today?`;
      }
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
