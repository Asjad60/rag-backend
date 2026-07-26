// const { callOpenRouterChat } = require('../llmService');

/**
 * Stage E: Generate Contextual Summary (Lightweight Metadata Context Method).
 * Generates an instant, zero-cost metadata context header without invoking an LLM API call.
 * Saves 1 LLM call per page during ingestion and eliminates crawling latency.
 *
 * @param {object} normalizedData - Normalized page data
 * @param {object} [options]       - Additional options
 * @returns {Promise<string>}      - Metadata context header string
 */
async function generateContextualSummary(normalizedData, options = {}) {
//   const { pageTitle, pageType, rawText, url } = normalizedData;

//   // Trim text sample for context generation
//   const textSample = rawText.length > 4000 ? rawText.slice(0, 4000) + '...' : rawText;

//   const prompt = `Page Title: ${pageTitle}
// Page URL: ${url}
// Page Type: ${pageType}

// Document Snippet:
// ${textSample}`;

//   const systemInstruction = `You are an expert AI summarizer implementing Anthropic's Contextual Retrieval method.
// Give a succinct (50-100 words) contextual summary of this document. Explain what this page/document is about, the key entity or topic it describes, and its primary purpose.
// Do NOT include preamble, quotes, or meta-comments. Output ONLY the raw contextual summary text.`;

//   try {
//     const summary = await callOpenRouterChat({
//       messages: [
//         { role: 'system', content: systemInstruction },
//         { role: 'user', content: prompt },
//       ],
//       temperature: 0.1,
//       maxTokens: 150,
//       operation: 'contextual_summary',
//       botId: options.botId,
//     });

//     return summary.trim();
//   } catch (error) {
//     console.warn(`⚠️ Contextual summary generation failed for ${url}:`, error.message);
//     // Fallback concise summary if LLM call fails
//     return `Page: ${pageTitle} (${pageType}). Contains information from ${url || 'website'}.`;
//   }
  const { pageTitle, pageType, url } = normalizedData || {};
  const title = pageTitle && pageTitle !== 'Untitled Page' ? pageTitle : 'Page';
  const typeLabel = pageType ? pageType.replace('_', ' ') : 'document';
  const summary = `Page: ${title} | Type: ${typeLabel}${url ? ` | URL: ${url}` : ''}`;
  return Promise.resolve(summary);
}

module.exports = { generateContextualSummary };
