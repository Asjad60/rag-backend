const { callOpenRouterChat } = require('../llmService');

/**
 * Stage D: Query Context Expansion & HyDE (Hypothetical Document Embeddings).
 * Generates a hypothetical ideal response/document snippet for the user query.
 * Embedding this hypothetical response produces significantly higher vector similarity
 * recall against true indexed document chunks than raw short queries.
 *
 * @param {string} query       - User query string
 * @param {Array}  chatHistory - Recent chat history
 * @returns {Promise<{ originalQuery: string, hydeText: string, expandedQuery: string }>}
 */
async function generateHyDEAndExpandQuery(query, chatHistory = [], options = {}) {
  const trimmed = query.trim();

  // Extract recent user/assistant turns for context expansion
  const recentHistory = chatHistory.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');

  const systemInstruction = `You are an expert search context generator implementing HyDE (Hypothetical Document Embeddings).
Given a user query and recent chat context, generate a hypothetical 1-2 paragraph snippet of what a perfect answer/document chunk in a knowledge base would look like.
Focus on domain terminology, facts, and relevant descriptions.
Do NOT output greetings, preamble, or meta-comments. Output ONLY the raw hypothetical document snippet.`;

  const userPrompt = recentHistory
    ? `Recent Context:\n${recentHistory}\n\nUser Query: ${trimmed}\n\nHypothetical Document Snippet:`
    : `User Query: ${trimmed}\n\nHypothetical Document Snippet:`;

  try {
    const hydeText = await callOpenRouterChat({
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 200,
      operation: 'hyde_expansion',
      botId: options.botId,
      sessionId: options.sessionId,
    });

    const expandedQuery = `${trimmed}\n\n${hydeText.trim()}`;
    console.log(`💡 [HyDE Generated] Query: "${trimmed}" -> HyDE snippet (${hydeText.length} chars)`);

    return {
      originalQuery: trimmed,
      hydeText: hydeText.trim(),
      expandedQuery,
    };
  } catch (error) {
    console.warn('⚠️ HyDE generation failed, falling back to original query:', error.message);
    return {
      originalQuery: trimmed,
      hydeText: trimmed,
      expandedQuery: trimmed,
    };
  }
}

module.exports = { generateHyDEAndExpandQuery };
