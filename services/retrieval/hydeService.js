const { callOpenRouterChat } = require("../llmService");

/**
 * Extracts the most likely subject/topic from the last user or assistant turn.
 * Used to resolve pronouns like "it", "this", "that" against recent context.
 *
 * @param {string} text - A single chat message
 * @returns {string}    - Best candidate noun phrase, or ''
 */
function extractLastSubject(text) {
  if (!text) return '';
  const cleaned = text.trim();

  // Look for quoted product/service names first
  const quoted = cleaned.match(/["\u201c\u2018]([^"\u201d\u2019]{2,60})["\u201d\u2019]/);
  if (quoted) return quoted[1].trim();

  // "price of X", "cost of X", "details of X", "info on X"
  const priceOf = cleaned.match(/\b(?:price|cost|details?|info(?:rmation)?|about|of|for)\s+(?:the\s+)?([A-Z][\w\s\-]{1,40})/i);
  if (priceOf) return priceOf[1].trim();

  // Capitalised noun phrases (likely product/service names): 2–5 consecutive title-case words
  const titleCase = cleaned.match(/(?:[A-Z][\w\-]+(?:\s+[A-Z][\w\-]+){1,4})/);
  if (titleCase) return titleCase[0].trim();

  // Fall back to the last sentence's noun-ish tail (last 1-3 words, ignoring trailing punctuation)
  const lastWords = cleaned.replace(/[.!?]+$/, '').split(/\s+/).slice(-3).join(' ');
  return lastWords.length > 2 ? lastWords : '';
}


function resolveAmbiguousPronouns(query, chatHistory = []) {
  const trimmed = (query || '').trim();
  if (!trimmed || !chatHistory || chatHistory.length === 0) {
    return { resolvedQuery: trimmed, wasResolved: false };
  }

  // Only act if the query actually contains ambiguous pronouns
  const pronounPattern = /\b(it|this|that|they|them|its|their|these|those)\b/i;
  if (!pronounPattern.test(trimmed)) {
    return { resolvedQuery: trimmed, wasResolved: false };
  }

  // Walk history newest-first; prefer user turns (they name the product), then assistant turns
  let subject = '';
  const ordered = [...chatHistory].reverse();
  for (const msg of ordered) {
    if (!msg || !msg.content) continue;
    const candidate = extractLastSubject(msg.content);
    if (candidate && candidate.split(/\s+/).length <= 6) {
      subject = candidate;
      break;
    }
  }

  if (!subject) {
    return { resolvedQuery: trimmed, wasResolved: false };
  }

  // Replace all ambiguous standalone pronouns with the resolved subject
  const resolved = trimmed.replace(
    /\b(it|this|that|they|them|its|their|these|those)\b/gi,
    subject,
  );

  if (resolved !== trimmed) {
    console.log(`🔗 [Pronoun Resolution] "${trimmed}" → "${resolved}" (subject: "${subject}")`);
    return { resolvedQuery: resolved, wasResolved: true };
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
