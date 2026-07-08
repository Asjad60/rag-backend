const axios = require('axios');

// ─── Intent Detection ─────────────────────────────────────────────────────────

const INTENT_PATTERNS = {
  contact: /contact|email|phone|call|reach|address|location|whatsapp|support|help desk|get in touch/i,
  product: /product|item|catalog|shop|buy|purchase|price|cost|how much|offer|deal|sale|discount|sku/i,
  pricing: /pricing|plan|subscription|package|tier|cost|fee|charge|affordable/i,
  navigation: /how (do|can) i|where (do|can) i|how to|steps|guide|tutorial|find|locate|navigate/i,
  about: /about|company|team|who are|history|mission|vision|founded/i,
  faq: /faq|common question|frequently asked/i,
  greeting: /^(hi|hello|hey|good morning|good evening|good afternoon|howdy|sup|greetings)[!?.]*$/i,
};

/**
 * Classifies the user's message into an intent category.
 */
function detectIntent(message) {
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(message)) return intent;
  }
  return 'general';
}

/**
 * Augments short or vague queries to improve vector search recall.
 */
function augmentQuery(message, intent) {
  const augmentations = {
    contact: `${message} contact information email phone address location`,
    product: `${message} product description price features availability`,
    pricing: `${message} pricing cost plans subscription fees`,
    navigation: `${message} steps how to guide instructions`,
    about: `${message} company about us mission team history`,
    faq: `${message} frequently asked questions`,
  };
  return augmentations[intent] || message;
}

// ─── Main LLM Caller ──────────────────────────────────────────────────────────

/**
 * Generates a chat response using an intent-aware, identity-injected system prompt.
 */
async function generateChatResponse(botMeta, contextText, chatHistory, intent = 'general') {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    return `[MOCK] No API key. Context received: ${contextText.substring(0, 100)}...`;
  }

  const { businessName, websiteUrl, systemPrompt } = botMeta;
  const identity = businessName
    ? `You are the AI assistant for ${businessName}${websiteUrl ? ` (${websiteUrl})` : ''}.`
    : `You are an AI assistant for a website.`;

  const basePrompt = systemPrompt || buildDefaultSystemPrompt(identity, websiteUrl, contextText);

  const messages = [
    { role: 'system', content: basePrompt },
    ...chatHistory,
  ];

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'meta-llama/llama-3-8b-instruct',
        messages,
        temperature: 0,
        max_tokens: 600,
      },
      {
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': websiteUrl || 'http://localhost:3000',
          'X-Title': businessName ? `${businessName} AI Assistant` : 'RAG Chatbot',
        },
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('LLM API Error:', error.response ? JSON.stringify(error.response.data) : error.message);
    throw new Error('Failed to generate response from LLM');
  }
}

// ─── System Prompt Builder ────────────────────────────────────────────────────

function buildDefaultSystemPrompt(identity, websiteUrl, contextText) {
  const fallback = websiteUrl
    ? `Visit [our website](${websiteUrl}) for more details.`
    : 'Please visit our website for more details.';

  return `${identity}
You are a concise assistant. Answer ONLY what the visitor asked — nothing more.

RULES:
- SHORT and DIRECT. No intros ("Sure!", "Great question!"), no summaries, no filler.
- Bullet lists: NO blank lines between items. Each on its own line starting with "- ".
- If a URL is available for something (product, page, booking, contact), use markdown: [label](url)
- Contact info: show email/phone directly. Link contact page if URL is known.
- Max 6 bullet points. If more, show top ones and say "(see more at [website](${websiteUrl || '#'}))"
- Never say "Based on the context..." or "According to the information..." — just answer.
- If not in context: "I don't have that info. ${fallback}"

CONTEXT:
${contextText || 'No context available.'}`;
}

module.exports = { generateChatResponse, detectIntent, augmentQuery };
