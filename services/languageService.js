const franc = require('franc');
const { callOpenRouterChat } = require('./llmService');

// ─── ISO 639-3 → Human-readable name map ─────────────────────────────────────
const LANG_NAMES = {
  eng: 'English',
  ara: 'Arabic',
  fra: 'French',
  deu: 'German',
  spa: 'Spanish',
  ita: 'Italian',
  por: 'Portuguese',
  rus: 'Russian',
  zho: 'Chinese',
  jpn: 'Japanese',
  kor: 'Korean',
  hin: 'Hindi',
  urd: 'Urdu',
  tur: 'Turkish',
  nld: 'Dutch',
  pol: 'Polish',
  ben: 'Bengali',
  vie: 'Vietnamese',
  tha: 'Thai',
  ind: 'Indonesian',
  msa: 'Malay',
  swa: 'Swahili',
  fas: 'Persian',
  heb: 'Hebrew',
  ron: 'Romanian',
  ces: 'Czech',
  hun: 'Hungarian',
  fin: 'Finnish',
  swe: 'Swedish',
  nor: 'Norwegian',
  dan: 'Danish',
  ukr: 'Ukrainian',
  chi: 'Chinese',
  fre: 'French',
  ger: 'German',
  per: 'Persian',
};

const ALIAS_MAP = {
  chi: 'zho',
  fre: 'fra',
  ger: 'deu',
  per: 'fas',
};

const ENGLISH_CODES = new Set(['eng', 'nds', 'sco', 'fuf', 'afr']);
const FRANC_MIN_RELIABLE_LEN = 40;
const FRANC_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Fast local language detection using franc (0 API cost, instant).
 */
function detectLanguageFranc(text) {
  const trimmed = (text || '').trim();
  if (trimmed.length < FRANC_MIN_RELIABLE_LEN) return 'eng';

  const results = franc.all(trimmed, { minLength: 10 });
  if (!results || results.length === 0) return 'eng';

  const [topCode, topScore] = results[0];
  if (topCode === 'und' || topScore < FRANC_CONFIDENCE_THRESHOLD) return 'eng';
  if (ENGLISH_CODES.has(topCode)) return 'eng';

  return topCode;
}

/**
 * Heuristics to determine if text is likely English.
 */
function isLikelyEnglish(text) {
  const clean = (text || '').toLowerCase().trim();
  if (!clean) return true;
  if (/[^\x20-\x7E]/.test(clean)) return false;

  const commonEnglishPattern = /^(hi|hello|hey|help|yes|no|ok|okay|thanks|thank you|pricing|products?|what|how|where|who|why|when|map|address|email|phone|info|about)[!?.]*$/i;
  if (commonEnglishPattern.test(clean)) return true;

  if (/[áéíóúüñäößçàèùâêîôûëïü]/.test(clean)) return false;

  const words = clean.split(/[^a-z]+/i).filter(Boolean);
  if (words.length > 0) {
    const commonEnglishWords = new Set([
      'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
      'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
      'this', 'but', 'his', 'by', 'from', 'we', 'say', 'her', 'she',
      'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
      'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
      'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take', 'people',
      'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than',
      'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back',
      'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way', 'even'
    ]);
    if (words.some(w => commonEnglishWords.has(w))) return true;
  }

  return false;
}

/**
 * Single Unified LLM Call: Detects Language AND Translates to English in 1 shot via OpenRouter.
 */
async function detectAndTranslateLLM(message, options = {}) {
  const systemInstruction = `You are a precision language detector and translator.
Analyze the user's message and reply ONLY with a JSON object in this format:
{
  "language": "ISO 639-3 3-letter code (e.g. eng, spa, fra, deu, zho, hin, urd, ara)",
  "translatedQuery": "English translation of the message (or original text if already English)"
}`;

  try {
    const raw = await callOpenRouterChat({
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: `Message: "${message}"` },
      ],
      temperature: 0.0,
      maxTokens: 150,
      operation: 'language_detection_and_translation',
      botId: options.botId,
      sessionId: options.sessionId,
    });

    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    const rawCode = (parsed.language || 'eng').toLowerCase();
    const detectedLang = ALIAS_MAP[rawCode] || rawCode;
    const translatedQuery = parsed.translatedQuery || message;

    return { detectedLang, translatedQuery };
  } catch (err) {
    console.warn('⚠️ Unified language detection/translation error:', err.message);
    return { detectedLang: 'eng', translatedQuery: message };
  }
}

/**
 * Unified Stage 1 Entry Point: Detects language & prepares English translated query.
 *
 * Performance Optimization:
 *   - Local franc check first (0ms, 0 API calls for English).
 *   - If non-English or uncertain, executes 1 SINGLE OpenRouter LLM call to get
 *     both language detection AND translation in 1 shot!
 *
 * @param {string} message - User query message
 * @param {object} [options] - { botId, sessionId }
 */
async function detectAndPrepare(message, options = {}) {
  let detectedLang = detectLanguageFranc(message);
  let translatedQuery = message;

  const isCertainEnglish = detectedLang === 'eng' && (message.length >= 40 || isLikelyEnglish(message));

  if (!isCertainEnglish) {
    // Single LLM call handles both language detection AND translation simultaneously
    const result = await detectAndTranslateLLM(message, options);
    detectedLang = result.detectedLang;
    translatedQuery = result.translatedQuery;
  }

  const isNonEnglish = detectedLang !== 'eng';
  const langName = LANG_NAMES[detectedLang] || detectedLang;

  if (isNonEnglish) {
    console.log(`🌐 [Lang] Detected ${langName} (${detectedLang}) | Translated: "${translatedQuery}"`);
  }

  return { detectedLang, langName, isNonEnglish, translatedQuery };
}

module.exports = {
  detectAndPrepare,
  detectLanguageFranc,
  detectAndTranslateLLM,
  LANG_NAMES,
};
