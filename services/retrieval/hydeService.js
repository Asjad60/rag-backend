const { callOpenRouterChat } = require("../llmService");

/**
 * 1. Very short queries (<= 4 words)
 * 2. Ambiguous queries lacking specificity
 * 3. Missing context / reliance on chat history
 * 4. Vocabulary mismatch / informal phrasing
 */
function shouldRunHyDE(query, chatHistory = [], intent = "general") {
  // 1. Environment Variable Control
  const hydeEnv = (process.env.ENABLE_HYDE || "true").toLowerCase().trim();
  if (hydeEnv === "false" || hydeEnv === "0" || hydeEnv === "off") {
    console.log("ℹ️ [HyDE Skipped] Disabled via ENABLE_HYDE env variable.");
    return false;
  }

  // 2. Skip for Non-Informational Intents (greeting, contact, vague clarification)
  if (["greeting", "contact", "vague"].includes(intent)) {
    console.log(
      `ℹ️ [HyDE Skipped] Intent "${intent}" does not require document expansion.`,
    );
    return false;
  }

  const trimmed = (query || "").trim();
  if (!trimmed) return false;

  // 3. Skip if Query contains direct explicit entities (URLs, Emails, Phone Numbers)
  const hasDirectEntities =
    /https?:\/\/|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\+?\d{10,}/.test(
      trimmed,
    );
  if (hasDirectEntities) {
    console.log(
      "ℹ️ [HyDE Skipped] Query contains direct entities (URL/email/phone).",
    );
    return false;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Criterion 1: Very short query (1 to 4 words) -> high benefit from expansion
  if (wordCount <= 4) {
    console.log(
      `💡 [HyDE Triggered] Reason 1: Very short query (${wordCount} words).`,
    );
    return true;
  }

  // Criterion 2 & 3: Ambiguous query / Missing context (pronouns, implicit follow-ups)
  const hasAmbiguousPronouns =
    /\b(it|this|that|they|them|its|their|these|those|there)\b/i.test(trimmed);
  const isQuestionWithoutSubject =
    /^(how|why|where|when|what|which|can i|is there|do you)\b/i.test(trimmed) &&
    wordCount < 8;
  const hasChatHistoryContext =
    chatHistory && chatHistory.length > 0 && wordCount < 7;
  if (
    hasAmbiguousPronouns ||
    isQuestionWithoutSubject ||
    hasChatHistoryContext
  ) {
    console.log(
      "💡 [HyDE Triggered] Reason 2/3: Ambiguous query or missing context.",
    );
    return true;
  }

  // Criterion 4: Vocabulary mismatch / Informal phrasing
  const informalPattern =
    /\b(cost|cheap|free|how much|help|setup|fix|issue|broken|problem|working|stuff|thing|way|option|kind|type|difference|pricing|support)\b/i;
  if (informalPattern.test(trimmed) && wordCount < 10) {
    console.log(
      "💡 [HyDE Triggered] Reason 4: Potential vocabulary mismatch or informal phrasing.",
    );
    return true;
  }

  // If query is already detailed, direct, and explicit (e.g. > 7-8 words without ambiguity), skip HyDE
  console.log(
    `ℹ️ [HyDE Skipped] Query is sufficiently clear and detailed (${wordCount} words).`,
  );
  return false;
}

/**
 * Stage D: Query Context Expansion & HyDE (Hypothetical Document Embeddings).
 * Generates a hypothetical ideal response/document snippet for the user query when triggered.
 *
 * @param {string} query       - User query string
 * @param {Array}  chatHistory - Recent chat history
 * @param {object} options     - { botId, sessionId, intent }
 * @returns {Promise<{ originalQuery: string, hydeText: string, expandedQuery: string }>}
 */
async function generateHyDEAndExpandQuery(
  query,
  chatHistory = [],
  options = {},
) {
  const trimmed = query.trim();
  const intent = options.intent || "general";

  // Check if HyDE should run based on ENV and trigger criteria
  if (!shouldRunHyDE(trimmed, chatHistory, intent)) {
    return {
      originalQuery: trimmed,
      hydeText: "",
      expandedQuery: trimmed,
    };
  }

  // Extract recent user/assistant turns for context expansion
  const recentHistory = chatHistory
    .slice(-4)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const systemInstruction = `You are an expert search context generator implementing HyDE (Hypothetical Document Embeddings).
Given a user query and recent chat context, generate a hypothetical 1-2 sentence target snippet of what a perfect answer/document chunk in a knowledge base would look like.
Focus on domain terminology, facts, and relevant descriptions.
Do NOT invent fake contact info or unverified prices.
Do NOT output greetings, preamble, or meta-comments. Output ONLY the raw hypothetical document snippet.`;

  const userPrompt = recentHistory
    ? `Recent Context:\n${recentHistory}\n\nUser Query: ${trimmed}\n\nHypothetical Document Snippet:`
    : `User Query: ${trimmed}\n\nHypothetical Document Snippet:`;

  try {
    const hydeText = await callOpenRouterChat({
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      maxTokens: 100,
      operation: "hyde_expansion",
      botId: options.botId,
      sessionId: options.sessionId,
    });

    const expandedQuery = `${trimmed}\n\n${hydeText.trim()}`;
    console.log(
      `💡 [HyDE Generated] Query: "${trimmed}" -> HyDE snippet (${hydeText.length} chars)`,
    );

    return {
      originalQuery: trimmed,
      hydeText: hydeText.trim(),
      expandedQuery,
    };
  } catch (error) {
    console.warn(
      "⚠️ HyDE generation failed, falling back to original query:",
      error.message,
    );
    return {
      originalQuery: trimmed,
      hydeText: "",
      expandedQuery: trimmed,
    };
  }
}

module.exports = { generateHyDEAndExpandQuery, shouldRunHyDE };
