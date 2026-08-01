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
  const isImplicitRequest = /^(give me the link|give link|link|show link|url|website link|where to buy|how to buy|what is the price|price|cost|is it in stock|buy link)\b/i.test(trimmed);
  const isObjection = /\b(wrong|incorrect|not have|does not have|doesn't have|how can you say)\b/i.test(trimmed);
  const isStandaloneQuestion = /^(what|where|who|why|how do|how can|do you|can you|is there|are there|tell me)\b/i.test(trimmed) && !hasPronouns;
  const isShortFragment = trimmed.split(/\s+/).length <= 4 && !isStandaloneQuestion;

  const needsResolution = (hasPronouns || isImplicitRequest || isObjection || isShortFragment) && !isStandaloneQuestion;
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
      const candidate = boldMatch[1].replace(/^(Title:|Product:|\s)+/i, "").trim();
      // Skip generic words and common UI/page headers like "Key Features", "About page", etc.
      if (!/^(Key Features|Colors Available|Sizes Available|Price|Description|Key Differences|About page|About Us|Contact Us|Home|Header|Footer|Note|Warning)$/i.test(candidate)) {
        explicitEntity = candidate;
        break;
      }
    }
    const linkMatch = msg.content.match(/\[([^\]]{2,60})\]\(/);
    if (linkMatch) {
      explicitEntity = linkMatch[1].replace(/^(here|link|website|view|\s)+/i, "").trim();
      if (explicitEntity.length > 2 && !/^(here|link|website|view|about|contact|home)$/i.test(explicitEntity)) break;
    }
  }

  // If Tier 1 found an explicit entity and query has pronouns or is an implicit fragment, resolve directly with entity
  if (explicitEntity && (hasPronouns || isImplicitRequest || isShortFragment)) {
    const cleanFollowUp = trimmed.replace(/\b(it|this|that|they|them|its|their|these|those|the product|the item)\b/gi, "").trim();
    let resolved = `${explicitEntity} ${cleanFollowUp}`.trim();
    if (/\b(feature|features|spec|specs|specification|specifications|material|fabric)\b/i.test(trimmed)) {
      resolved = `${explicitEntity} specifications features material fabric details ${cleanFollowUp}`.trim();
    }
    console.log(`⚡ [Query Reformulation - Fast Path] "${trimmed}" → "${resolved}" (Entity: "${explicitEntity}")`);
    return { resolvedQuery: resolved, wasResolved: true };
  }

  // Tier 2: LLM Contextual Query Rewriter with 2.5s safety timeout
  try {
    const historyText = recentHistory.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n");
    const systemPrompt = `You are a Contextual Query Rewriter for search engines.
Given the recent chat history and a user's follow-up query, rewrite the user query into a single, clear, self-contained search query.
- Replace ambiguous pronouns ("it", "this", "that") and implicit references with the exact product name or subject from the chat history.
- If the user is asking for a link, price, or size, include the product name and requested attribute.
- Do NOT answer the question. Reply ONLY with the rewritten single-line search query.`;

    const userPrompt = `Chat History:\n${historyText}\n\nUser Query: "${trimmed}"\n\nStandalone Search Query:`;

    const llmPromise = callOpenRouterChat({
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

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve(null), 2500)
    );

    const rewritten = await Promise.race([llmPromise, timeoutPromise]);

    const cleanRewritten =
      typeof rewritten === "string"
        ? rewritten.replace(/^["']|["']$/g, "").trim()
        : "";
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
function shouldRunHyDE(query, chatHistory = [], intent = "general", options = {}) {
  // 1. Environment Variable Control
  const hydeEnv = (process.env.ENABLE_HYDE || "true").toLowerCase().trim();
  if (hydeEnv === "false" || hydeEnv === "0" || hydeEnv === "off") {
    console.log("ℹ️ [HyDE Skipped] Disabled via ENABLE_HYDE env variable.");
    return false;
  }

  // 2. Rule 1: Skip HyDE after successful query rewriting / pronoun resolution
  if (options && options.wasResolved) {
    console.log("ℹ️ [HyDE Skipped] Rule 1: Query was successfully rewritten/resolved.");
    return false;
  }

  // 3. Skip for Non-Informational Intents or Correction/Feedback queries
  if (["greeting", "contact", "vague"].includes(intent)) {
    console.log(
      `ℹ️ [HyDE Skipped] Intent "${intent}" does not require document expansion.`,
    );
    return false;
  }

  const trimmed = (query || "").trim();
  if (!trimmed) return false;

  // Rule 4: Skip HyDE for correction/error feedback messages
  const isCorrectionFeedback = /\b(wrong|incorrect|invalid|error|showing the wrong|not right)\b/i.test(trimmed);
  if (isCorrectionFeedback) {
    console.log("ℹ️ [HyDE Skipped] Rule 4: Query is a correction/error feedback message.");
    return false;
  }

  // 4. Rule 3: Skip if Query contains direct explicit entities (URLs, emails, phones)
  const hasDirectEntities =
    /https?:\/\/|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\+?\d{10,}/.test(trimmed);
  if (hasDirectEntities) {
    console.log("ℹ️ [HyDE Skipped] Rule 3: Query contains direct contact entities.");
    return false;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // 5. Very short vague query (1 to 3 words) without explicit product terms -> benefit from expansion
  if (wordCount <= 3) {
    console.log(
      `💡 [HyDE Triggered] Reason 1: Very short vague query (${wordCount} words).`,
    );
    return true;
  }

  // 6. Ambiguous query with pronouns or missing subject
  const hasAmbiguousPronouns =
    /\b(it|this|that|they|them|its|their|these|those|there)\b/i.test(trimmed);

  if (hasAmbiguousPronouns) {
    console.log(
      "💡 [HyDE Triggered] Reason 2: Ambiguous query with pronoun reference.",
    );
    return true;
  }

  // 7. Broad catalog/collection discovery queries (e.g. "what catalogs do you provide?", "what collections do you have?")
  const isCatalogDiscovery = /\b(catalog|catalogs|collection|collections|category|categories|what do you sell|what do you offer|what do you provide|all products)\b/i.test(trimmed);
  if (isCatalogDiscovery) {
    console.log(
      "💡 [HyDE Triggered] Reason 3: Broad catalog/collection discovery query requiring expansion.",
    );
    return true;
  }

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
 * @param {object} options     - { botId, sessionId, intent, wasResolved }
 * @returns {Promise<{ originalQuery: string, hydeText: string, expandedQuery: string }>}
 */
async function generateHyDEAndExpandQuery(
  query,
  chatHistory = [],
  options = {},
) {
  const trimmed = query.trim();
  const intent = options.intent || "general";

  // Synonym expansion for e-commerce catalog / collection queries
  let baseExpandedQuery = trimmed;
  if (/\b(catalog|catalogs)\b/i.test(trimmed)) {
    baseExpandedQuery = `${trimmed} collections categories products apparel items`;
  }

  // Check if HyDE should run based on ENV and trigger criteria
  if (!shouldRunHyDE(trimmed, chatHistory, intent, options)) {
    return {
      originalQuery: trimmed,
      hydeText: "",
      expandedQuery: baseExpandedQuery,
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
    const llmPromise = callOpenRouterChat({
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

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve(""), 2500)
    );

    const hydeText = await Promise.race([llmPromise, timeoutPromise]);

    const cleanHyDE = typeof hydeText === "string" ? hydeText.trim() : "";
    const expandedQuery = cleanHyDE ? `${trimmed}\n\n${cleanHyDE}` : trimmed;
    console.log(
      `💡 [HyDE Generated] Query: "${trimmed}" -> HyDE snippet (${cleanHyDE.length} chars)`
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