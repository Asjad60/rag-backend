const { callOpenRouterChat } = require("../llmService");

/**
 * Enterprise-grade Contextual Query Reformulation & Pronoun Resolution.
 *
 * Rewrites ambiguous follow-up queries, pronoun references ("it", "this", "that"),
 * and implicit requests ("give me the link", "how much is it") into clear, self-contained search queries.
 *
 * @param {string} query       - Raw user query
 * @param {Array}  chatHistory - Recent conversation history
 * @param {object} options     - { botId, sessionId }
 * @returns {Promise<{ resolvedQuery: string, wasResolved: boolean }>}
 */
async function resolveAmbiguousPronouns(query, chatHistory = [], options = {}) {
  const trimmed = (query || "").trim();
  if (!trimmed || !chatHistory || chatHistory.length === 0) {
    return { resolvedQuery: trimmed, wasResolved: false };
  }

  // 1. Fast Guard: Check if query requires contextual resolution
  const hasPronouns = /\b(it|this|that|they|them|its|their|these|those|the product|the item)\b/i.test(trimmed);
  const isShortFollowUp = trimmed.split(/\s+/).length <= 5;
  const isImplicitRequest = /^(give me the link|give link|link|show link|url|website link|where to buy|how to buy|what is the price|price|cost|is it in stock|buy link)\b/i.test(trimmed);
  const isObjection = /\b(wrong|incorrect|not have|does not have|doesn't have|how can you say)\b/i.test(trimmed);

  const needsResolution = hasPronouns || isShortFollowUp || isImplicitRequest || isObjection;
  if (!needsResolution) {
    return { resolvedQuery: trimmed, wasResolved: false };
  }

  // 2. Extract recent conversation context (last 2 turns)
  const recentHistory = chatHistory.slice(-4);
  let explicitEntity = "";

  // Tier 1 Fast Extraction: Search recent history for bolded text (**Product Name**) or markdown links ([Product Name](...))
  for (const msg of [...recentHistory].reverse()) {
    if (!msg || !msg.content) continue;
    const boldMatch = msg.content.match(/\*\*([^*]{2,60})\*\*/);
    if (boldMatch) {
      explicitEntity = boldMatch[1].replace(/^(Title:|Product:|\s)+/i, "").trim();
      break;
    }
    const linkMatch = msg.content.match(/\[([^\]]{2,60})\]\(/);
    if (linkMatch) {
      explicitEntity = linkMatch[1].replace(/^(here|link|website|view|\s)+/i, "").trim();
      if (explicitEntity.length > 2) break;
    }
  }

  // If Tier 1 found an explicit entity and query is a simple link/price request, resolve fast!
  if (explicitEntity && (isImplicitRequest || (isShortFollowUp && hasPronouns))) {
    const resolved = `${explicitEntity} ${trimmed}`;
    console.log(`⚡ [Query Reformulation - Fast Path] "${trimmed}" → "${resolved}" (Entity: "${explicitEntity}")`);
    return { resolvedQuery: resolved, wasResolved: true };
  }

  // Tier 2: LLM Contextual Query Rewriter
  try {
    const historyText = recentHistory.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n");
    const systemPrompt = `You are a Contextual Query Rewriter for search engines.
Given the recent chat history and a user's follow-up query, rewrite the user query into a single, clear, self-contained search query.
- Replace ambiguous pronouns ("it", "this", "that") and implicit references with the exact product name or subject from the chat history.
- If the user is asking for a link, price, or size, include the product name and requested attribute.
- Do NOT answer the question. Reply ONLY with the rewritten single-line search query.`;

    const userPrompt = `Chat History:\n${historyText}\n\nUser Query: "${trimmed}"\n\nStandalone Search Query:`;

    const rewritten = await callOpenRouterChat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.0,
      maxTokens: 40,
      operation: "query_reformulation",
      botId: options.botId,
      sessionId: options.sessionId,
    });

    const cleanRewritten = rewritten.replace(/^["']|["']$/g, "").trim();
    if (cleanRewritten && cleanRewritten !== trimmed) {
      console.log(`🧠 [Query Reformulation - LLM Path] "${trimmed}" → "${cleanRewritten}"`);
      return { resolvedQuery: cleanRewritten, wasResolved: true };
    }
  } catch (err) {
    console.warn(`⚠️ [Query Reformulation Fallback] LLM rewriter error, using fallback:`, err.message);
  }

  // Fallback if LLM path produced no change
  if (explicitEntity) {
    const fallbackResolved = `${explicitEntity} ${trimmed}`;
    return { resolvedQuery: fallbackResolved, wasResolved: true };
  }

  return { resolvedQuery: trimmed, wasResolved: false };
}

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

  // Criterion 2 & 3: Ambiguous query / Missing context (pronouns, feedback/corrections, implicit follow-ups)
  const hasAmbiguousPronouns =
    /\b(it|this|that|they|them|its|their|these|those|there|you|your)\b/i.test(trimmed);
  const hasCorrectionFeedback =
    /\b(wrong|incorrect|invalid|error|showing the wrong|not right)\b/i.test(trimmed);
  const isQuestionWithoutSubject =
    /^(how|why|where|when|what|which|can i|is there|do you)\b/i.test(trimmed) &&
    wordCount < 8;
  const hasChatHistoryContext =
    chatHistory && chatHistory.length > 0 && wordCount < 10;
  if (
    hasAmbiguousPronouns ||
    hasCorrectionFeedback ||
    isQuestionWithoutSubject ||
    hasChatHistoryContext
  ) {
    console.log(
      "💡 [HyDE Triggered] Reason 2/3: Ambiguous query, feedback correction, or missing context.",
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

module.exports = { generateHyDEAndExpandQuery, shouldRunHyDE, resolveAmbiguousPronouns };
