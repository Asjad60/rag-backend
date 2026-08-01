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

/**
 * Helper to execute chat completions via OpenRouter with streaming.
 */
async function callOpenRouterChatStream({
  messages,
  temperature = 0,
  maxTokens = 600,
  model = OPENROUTER_CHAT_MODEL,
  operation = "chat_response",
  botId = null,
  sessionId = "",
  onToken,
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
      stream: true,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ragchatbot.local",
        "X-Title": "RAG Chatbot",
      },
      responseType: "stream",
      timeout: 30_000,
    },
  );

  return new Promise((resolve, reject) => {
    let fullText = "";
    let buffer = "";

    response.data.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed === "data: [DONE]") continue;

        if (trimmed.startsWith("data: ")) {
          try {
            const dataStr = trimmed.slice(6);
            const parsed = JSON.parse(dataStr);
            const token = parsed.choices?.[0]?.delta?.content || "";
            if (token) {
              fullText += token;
              if (onToken) onToken(token);
            }
          } catch (_) {}
        }
      }
    });

    response.data.on("end", () => {
      if (buffer.trim().startsWith("data: ") && buffer.trim() !== "data: [DONE]") {
        try {
          const parsed = JSON.parse(buffer.trim().slice(6));
          const token = parsed.choices?.[0]?.delta?.content || "";
          if (token) {
            fullText += token;
            if (onToken) onToken(token);
          }
        } catch (_) {}
      }
      resolve(fullText.trim());
    });

    response.data.on("error", (err) => {
      reject(err);
    });
  });
}

// ─── Intent Patterns ──────────────────────────────────────────────────────────

const INTENT_PATTERNS = {
  greeting:
    /^(hi|hello|hey|good morning|good evening|good afternoon|howdy|sup|greetings|whats up|what's up|what up|how are you|how's it going|nice to meet you|good day|你好|hola|bonjour|hallo|ciao)([\s,]+(bud|buddy|friend|pal|man|bro|there|all))?[!?.]*$/i,
  gratitude:
    /^(thanks|thank you|thx|appreciate|thank|great|awesome|perfect|cool|ok|okay|nice|sounds good|got it|thank\s*you\s*so\s*much|thanks\s*a\s*lot)[!?.]*$/i,
  product:
    /product|item|catalog|shop|buy|purchase|price|cost|how much|offer|deal|sale|discount|sku|in stock|available|order|compare|pricing|plan|subscription|package|tier|fee|charge|affordable|recommendation|recommend|suggest|suggestion|option|choice|variant|difference|diff|spec|specs|specification|specifications|feature|features|material|fabric|quality|detail|details|precio|comprar|价格|买|购买|producto|acheter|prix/i,
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
  const chatHistory = options.chatHistory || [];

  if (INTENT_PATTERNS.gratitude.test(trimmed)) return "gratitude";
  if (INTENT_PATTERNS.greeting.test(trimmed)) return "greeting";

  const smalltalkPattern = /^(whats up|what's up|how are you|how is it going|how's it going|who are you|what can you do|who made you|nice to meet you|good day)/i;
  if (smalltalkPattern.test(trimmed)) return "greeting";

  const cjkCount = (
    trimmed.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7a3]/g) || []
  ).length;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length + cjkCount;

  // Check pattern matches first
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (intent === "greeting" || intent === "gratitude") continue;
    if (pattern.test(trimmed)) return intent;
  }

  // If chatHistory is present, inherit product intent from recent turn for short follow-ups
  if (chatHistory.length > 0) {
    const lastUserTurn = [...chatHistory].reverse().find(m => m && m.role === 'user');
    if (lastUserTurn && INTENT_PATTERNS.product.test(lastUserTurn.content || "")) {
      return "product";
    }
  }

  // Only return "vague" if there is NO chatHistory context
  if (wordCount < 3 && chatHistory.length === 0) return "vague";

  // LLM Fallback via OpenRouter
  try {
    const raw = await callOpenRouterChat({
      messages: [
        {
          role: "system",
          content:
            "Classify the user's message into exactly ONE of these intents: greeting, gratitude, product, contact, about, faq, navigation, general. Reply ONLY with the single word of the intent.",
        },
        { role: "user", content: trimmed },
      ],
      temperature: 0,
      maxTokens: 10,
      operation: "intent_detection",
      botId: options.botId,
      sessionId: options.sessionId,
    });

    const llmIntent = typeof raw === "string" ? raw.toLowerCase().trim() : "";
    const validIntents = [
      "greeting",
      "gratitude",
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
  if (intent === "gratitude") return "gratitude";
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

  const basePrompt = buildDefaultSystemPrompt(botMeta, contextText);
  const langPrompt = `\n\nIMPORTANT: The user is speaking ${langName}. You MUST write your final response strictly in ${langName}. Do NOT reply in English unless the user spoke English. Base your answer entirely on the context provided above.`;

  const systemMessage = {
    role: "system",
    content: basePrompt + langPrompt,
  };

  const recentHistory = (chatHistory || []).slice(-4);
  const formattedHistory = recentHistory.map((msg) => {
    const isAssistant = msg.role === "assistant";
    let content = msg.content || "";
    if (isAssistant && content.length > 250) {
      content = content.slice(0, 250) + "...";
    }
    return {
      role: isAssistant ? "assistant" : "user",
      content,
    };
  });

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

async function generateChatResponseStream(
  botMeta,
  contextText,
  chatHistory,
  intent = "general",
  langName = "English",
  options = {},
  onToken,
) {
  const { businessName, websiteUrl, systemPrompt } = botMeta;
  const identity = businessName
    ? `You are the AI assistant for ${businessName}${websiteUrl ? ` (${websiteUrl})` : ""}.`
    : "You are an AI assistant for a website.";

  const basePrompt = buildDefaultSystemPrompt(botMeta, contextText);
  const langPrompt = `\n\nIMPORTANT: The user is speaking ${langName}. You MUST write your final response strictly in ${langName}. Do NOT reply in English unless the user spoke English. Base your answer entirely on the context provided above.`;

  const systemMessage = {
    role: "system",
    content: basePrompt + langPrompt,
  };

  const recentHistory = (chatHistory || []).slice(-4);
  const formattedHistory = recentHistory.map((msg) => {
    const isAssistant = msg.role === "assistant";
    let content = msg.content || "";
    if (isAssistant && content.length > 250) {
      content = content.slice(0, 250) + "...";
    }
    return {
      role: isAssistant ? "assistant" : "user",
      content,
    };
  });

  try {
    const reply = await callOpenRouterChatStream({
      messages: [systemMessage, ...formattedHistory],
      temperature: 0.1,
      maxTokens: 650,
      operation: "chat_response",
      botId: options.botId,
      sessionId: options.sessionId,
      onToken,
    });
    return reply;
  } catch (error) {
    console.error("❌ OpenRouter LLM Streaming API Error:", error.message);
    throw new Error(
      `Failed to generate response from OpenRouter: ${error.message}`,
    );
  }
}

// ─── System Prompt Builder ────────────────────────────────────────────────────

function buildDefaultSystemPrompt(botMeta = {}, contextText = "") {
  const { businessName, websiteUrl, role, businessSummary, systemPrompt } = botMeta;

  if (systemPrompt && systemPrompt.trim().length > 20) {
    return `${systemPrompt.trim()}\n\nCONTEXT:\n${contextText || "No context available."}`;
  }

  const name = businessName || "our website";
  const fallback = websiteUrl
    ? `Visit [our website](${websiteUrl}) for more details.`
    : "Please visit our website for more details.";

  const roleDescriptions = {
    shopping_assistant: `Shopping assistant for ${name}, helping customers explore products, compare options, check prices and features, and guide them smoothly.`,
    customer_support: `Customer support specialist for ${name}, assisting with orders, policies, services, hours, and general customer inquiries.`,
    lead_generation: `Sales and lead generation representative for ${name}, answering product and service questions and guiding potential clients to get in touch.`,
    technical_support: `Technical support representative for ${name}, helping users troubleshoot issues, understand specifications, and follow step-by-step guides.`,
    general_assistant: `AI Assistant for ${name}, providing helpful, accurate answers about products, services, offerings, and company information.`,
  };

  const selectedRoleText = roleDescriptions[role] || (typeof role === 'string' && role.trim() ? role.trim() : roleDescriptions.general_assistant);
  const businessContextSection = businessSummary ? `\n### Business Context\n${businessSummary.trim()}\n` : "";

  return `### Role
${selectedRoleText}
${businessContextSection}
### Core Constraints
1. Exclusive Reliance on Context: Answer strictly using facts provided in the CONTEXT below. Summarize the information, offerings, categories, or items found in the CONTEXT. If a query is completely uncovered by the CONTEXT, respond politely stating you don't have those specific details and suggest: "${fallback}"
2. Maintain Focus & Role: Stay in character as a helpful assistant for ${name}. Do not perform tasks or answer questions unrelated to the business or site content.
3. No System Divulging: Never mention that you have access to internal context chunks, database, or training data explicitly to the user.

### Response & Grounding Rules
1. Factual Grounding: State ONLY facts, features, options, pricing, and links present in the CONTEXT. NEVER invent or guess generic unverified claims.
2. Link Accuracy: Extract exact page URLs from the matching result block. Format links as [Page/Item Name](URL). Never attach a URL from an unrelated page.
3. Data Integrity: Treat each information block independently. Never copy, transpose, or mix prices, URLs, or details between neighboring entries.
4. Missing Details: If specific details requested are NOT in the CONTEXT, answer with what is available in the summary and direct the user to the relevant link.
5. Inquiries & Overview: If the user asks broadly about what is offered or available, summarize the main topics, products, or services listed in the CONTEXT and invite them to explore.

### Response Formatting
- Use Markdown headers (###), bold text, and clean bullet points (-).
- DO NOT use Markdown tables (| Header 1 | Header 2 |). Format information using clean bullet lists or bold key-value pairs so it displays clearly in mobile chat widgets.

CONTEXT:
${contextText || "No context available."}`;
}

module.exports = {
  callOpenRouterChat,
  callOpenRouterChatStream,
  detectIntent,
  getRoutingBranch,
  augmentQuery,
  checkGuardrails,
  generateClarifyResponse,
  generateChatResponse,
  generateChatResponseStream,
};
