const axios = require("axios");
const { logLlmUsage } = require("./llmUsageService");

const OPENROUTER_CHAT_MODEL =
  process.env.OPENROUTER_CHAT_MODEL || "openai/gpt-4o-mini";

/**
 * Helper to execute chat completions via OpenRouter.
 */
async function callOpenRouterChat({
  messages,
  temperature = 0,
  maxTokens = 600,
  model = OPENROUTER_CHAT_MODEL,
  operation = "chat_response",
  botId = null,
  sessionId = "",
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ragchatbot.local",
        "X-Title": "RAG Chatbot",
      },
      timeout: 30_000,
    },
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (content === undefined) {
    throw new Error("Invalid chat response from OpenRouter");
  }

  // Asynchronously log LLM usage for observability
  const usage = response.data?.usage;
  if (usage) {
    logLlmUsage({
      botId,
      sessionId,
      operation,
      modelName: model,
      openRouterUsage: usage,
    }).catch(() => {});
  }

  return content.trim();
}

// ─── Intent Patterns ──────────────────────────────────────────────────────────

const INTENT_PATTERNS = {
  greeting:
    /^(hi|hello|hey|good morning|good evening|good afternoon|howdy|sup|greetings|你好|hola|bonjour|hallo|ciao)[!?.]*$/i,
  product:
    /product|item|catalog|shop|buy|purchase|price|cost|how much|offer|deal|sale|discount|sku|in stock|available|order|compare|pricing|plan|subscription|package|tier|fee|charge|affordable|precio|comprar|价格|买|购买|producto|acheter|prix/i,
  contact:
    /contact|email|phone|call|reach|address|location|whatsapp|support|help desk|get in touch|contacto|联系|电话|邮箱/i,
  about:
    /about|company|team|who are|history|mission|vision|founded|sobre|关于|公司/i,
  faq: /faq|common question|frequently asked|preguntas|常见问题/i,
  navigation:
    /how (do|can) i|where (do|can) i|how to|steps|guide|tutorial|find|locate|navigate|como|怎么|如何/i,
};

// ─── Intent Detection (Stage 2) ───────────────────────────────────────────────

async function detectIntent(message, options = {}) {
  const trimmed = message.trim();

  if (INTENT_PATTERNS.greeting.test(trimmed)) return "greeting";

  const cjkCount = (
    trimmed.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7a3]/g) || []
  ).length;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length + cjkCount;
  const matchesKnownPattern = Object.entries(INTENT_PATTERNS)
    .filter(([k]) => k !== "greeting")
    .some(([, pattern]) => pattern.test(trimmed));

  if (wordCount < 3 && !matchesKnownPattern) return "vague";

  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (intent === "greeting") continue;
    if (pattern.test(trimmed)) return intent;
  }

  // LLM Fallback via OpenRouter
  try {
    const raw = await callOpenRouterChat({
      messages: [
        {
          role: "system",
          content:
            "Classify the user's message into exactly ONE of these intents: product, contact, about, faq, navigation, general. Reply ONLY with the single word of the intent.",
        },
        { role: "user", content: trimmed },
      ],
      temperature: 0,
      maxTokens: 10,
      operation: "intent_detection",
      botId: options.botId,
      sessionId: options.sessionId,
    });

    const llmIntent = raw.toLowerCase().trim();
    const validIntents = [
      "product",
      "contact",
      "about",
      "faq",
      "navigation",
      "general",
    ];
    if (validIntents.includes(llmIntent)) {
      console.log(
        `🤖 [OpenRouter Intent Fallback] "${trimmed}" -> ${llmIntent}`,
      );
      return llmIntent;
    }
  } catch (err) {
    console.warn("⚠️ OpenRouter intent detection failed:", err.message);
  }

  return "general";
}

function getRoutingBranch(intent) {
  if (intent === "greeting") return "greeting";
  if (intent === "vague") return "clarify";
  if (intent === "product") return "product";
  return "semantic";
}

function augmentQuery(message, intent) {
  const augmentations = {
    product: `${message} product description price features availability buy purchase`,
    contact: `${message} contact information email phone address location`,
    about: `${message} company about us mission team history`,
    faq: `${message} frequently asked questions answers`,
    navigation: `${message} steps how to guide instructions`,
    general: message,
  };
  return augmentations[intent] || message;
}

// ─── Guardrails ──────────────────────────────────────────────────────────────

const GUARDRAIL_PATTERNS = [
  /ignore (all )?(previous|prior|above|your) (instructions?|prompts?|context|rules?)/i,
  /act as (a |an )?(different|new|another|evil|unrestricted|uncensored|gpt|chatgpt|openai)/i,
  /you are now|pretend (you are|to be)|role[\s-]?play as/i,
  /jailbreak|dan mode|developer mode|god mode|bypass (your )?(rules?|restrictions?|filters?|safety)/i,
  /forget (your|all) (instructions?|training|rules?|guidelines?|constraints?)/i,
  /prompt injection|override (the )?(system|instructions?|prompt)|system prompt/i,
  /disregard (your|all|any) (previous|prior|above) (instructions?|prompts?)/i,
];

function checkGuardrails(message) {
  for (const pattern of GUARDRAIL_PATTERNS) {
    if (pattern.test(message)) {
      return { fired: true, reason: "prompt_injection" };
    }
  }
  return { fired: false, reason: null };
}

// ─── Clarify Response Generator ───────────────────────────────────────────────

async function generateClarifyResponse(
  botMeta,
  message,
  langName = "English",
  options = {},
) {
  const { businessName, websiteUrl } = botMeta;
  const identity = businessName
    ? `You are the AI assistant for ${businessName}${websiteUrl ? ` (${websiteUrl})` : ""}.`
    : "You are an AI assistant for a website.";

  try {
    const raw = await callOpenRouterChat({
      messages: [
        {
          role: "system",
          content: `${identity}\nYou are a customer support assistant. The user sent a short or unclear message. Reply with exactly ONE short, friendly clarifying question in ${langName}. Do NOT output any meta-text, quotes, or greetings.`,
        },
        { role: "user", content: `User message: ${message}` },
      ],
      temperature: 0.2,
      maxTokens: 60,
      operation: "clarify_response",
      botId: options.botId,
      sessionId: options.sessionId,
    });

    return raw.replace(/^["']|["']$/g, "").trim();
  } catch (error) {
    console.error("❌ OpenRouter Clarify response error:", error.message);
    return "Could you please provide more details so I can give you the most relevant answer?";
  }
}

// ─── Main Chat Response Generator ─────────────────────────────────────────────

async function generateChatResponse(
  botMeta,
  contextText,
  chatHistory,
  intent = "general",
  langName = "English",
  options = {},
) {
  const { businessName, websiteUrl, systemPrompt } = botMeta;
  const identity = businessName
    ? `You are the AI assistant for ${businessName}${websiteUrl ? ` (${websiteUrl})` : ""}.`
    : "You are an AI assistant for a website.";

  const basePrompt =
    systemPrompt || buildDefaultSystemPrompt(identity, websiteUrl, contextText);
  const langPrompt = `\n\nIMPORTANT: The user is speaking ${langName}. You MUST write your final response strictly in ${langName}. Do NOT reply in English unless the user spoke English. Base your answer entirely on the context provided above.`;

  const systemMessage = {
    role: "system",
    content: basePrompt + langPrompt,
  };

  const formattedHistory = chatHistory.map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content,
  }));

  try {
    const reply = await callOpenRouterChat({
      messages: [systemMessage, ...formattedHistory],
      temperature: 0.1,
      maxTokens: 650,
      operation: "chat_response",
      botId: options.botId,
      sessionId: options.sessionId,
    });
    return reply;
  } catch (error) {
    console.error("❌ OpenRouter LLM API Error:", error.message);
    throw new Error(
      `Failed to generate response from OpenRouter: ${error.message}`,
    );
  }
}

// ─── System Prompt Builder ────────────────────────────────────────────────────

function buildDefaultSystemPrompt(identity, websiteUrl, contextText) {
  const fallback = websiteUrl
    ? `Visit [our website](${websiteUrl}) for more details.`
    : "Please visit our website for more details.";

  return `${identity}
You are a helpful, professional AI assistant. Provide beautifully formatted, clear, and structured answers using clean Markdown.

FORMATTING & STYLE GUIDELINES:
- Use clean Markdown headers (e.g. ### Section Title) when organizing structured information.
- Use bold text (**Key Terms**) for key entities, labels, product names, or important details.
- Use clean bullet points (- ) or numbered lists (1. ) for step-by-step guides, features, or options.
- Use tables (| Header 1 | Header 2 |) when comparing features, options, or specs if relevant.
- Keep responses direct, elegant, and easy to read. Avoid conversational filler or meta-comments like "Based on the context...".
- Contact info: show email/phone directly. Link contact pages using their exact URL from the context.
- If info is not in the context: "I don't have specific details on that. ${fallback}"

LINKING RULES — follow strictly:
- The CONTEXT below contains RESULT blocks with "URL:" lines. Use those exact URLs when mentioning pages, products, or services: [Title](URL)
- NEVER invent, guess, or construct a URL. Use ONLY URLs provided in the context.

CONTEXT:
${contextText || "No context available."}`;
}

module.exports = {
  callOpenRouterChat,
  detectIntent,
  getRoutingBranch,
  augmentQuery,
  checkGuardrails,
  generateClarifyResponse,
  generateChatResponse,
};
