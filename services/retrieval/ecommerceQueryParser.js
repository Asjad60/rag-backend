const { callOpenRouterChat } = require("../llmService");

/**
 * Enterprise-grade E-Commerce Query Parser.
 *
 * Employs a Two-Tier Strategy:
 *   Tier 1: Fast-path RegEx / Pattern-based extraction (0ms, 0 cost).
 *   Tier 2: LLM structured constraint & entity extraction (fallback for complex natural language queries).
 */

const COLOR_DICTIONARY = [
  "black", "white", "red", "blue", "green", "yellow", "pink", "purple",
  "orange", "grey", "gray", "brown", "navy", "maroon", "beige", "gold", "silver"
];

const SIZE_DICTIONARY = ["xs", "s", "m", "l", "xl", "xxl", "3xl", "small", "medium", "large", "extra large"];

/**
 * Fast-path RegEx parser for prices, sizes, colors, and comparison intent.
 *
 * @param {string} query
 * @returns {object} Extracted constraints
 */
function parseFastRegEx(query) {
  const qLower = (query || "").toLowerCase();

  let maxPrice = null;
  let minPrice = null;

  // Price extraction patterns: "under 500", "below 1000", "under $50.99", "< 500", "less than 500", "around 500", "between 200 and 800"
  const rangeMatch = qLower.match(/(?:between|from)\s+(?:₹|\$|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(?:and|to|-)\s*(?:₹|\$|rs\.?|inr)?\s*(\d+(?:\.\d+)?)/i);
  if (rangeMatch) {
    minPrice = parseFloat(rangeMatch[1]);
    maxPrice = parseFloat(rangeMatch[2]);
  } else {
    const maxMatch = qLower.match(/(?:under|below|less than|<|up to|within|around|costing|budget of)\s*(?:₹|\$|rs\.?|inr)?\s*(\d+(?:\.\d+)?)/i) ||
                     qLower.match(/(\d+(?:\.\d+)?)\s*(?:rupees?|rs|inr|bucks|\$)?\s*(?:or less|under|below|max)/i);
    if (maxMatch) {
      maxPrice = parseFloat(maxMatch[1]);
    }

    const minMatch = qLower.match(/(?:above|more than|>|over|at least|starting from)\s*(?:₹|\$|rs\.?|inr)?\s*(\d+(?:\.\d+)?)/i);
    if (minMatch) {
      minPrice = parseFloat(minMatch[1]);
    }
  }

  // Color extraction
  const detectedColors = COLOR_DICTIONARY.filter(color => {
    const regex = new RegExp(`\\b${color}\\b`, "i");
    return regex.test(qLower);
  });

  // Alpha size extraction (e.g. "size M", "M size", "medium size", "size small")
  const detectedSizes = [];
  SIZE_DICTIONARY.forEach(sz => {
    const regex = new RegExp(`\\b(?:size\\s+${sz}|${sz}\\s+size|size\\s*:\\s*${sz})\\b`, "i");
    if (regex.test(qLower)) {
      const normalized = sz.length <= 3 ? sz.toUpperCase() : sz;
      if (!detectedSizes.includes(normalized)) detectedSizes.push(normalized);
    }
  });

  // Numeric size extraction (e.g. "size 10", "shoes size 9.5", "size 42", "waist 32", "UK 9", "US 10", "EU 42")
  const numericSizeMatches = qLower.matchAll(/\b(?:size\s*[:=]?\s*|waist\s*[:=]?\s*|uk\s+|us\s+|eu\s+)?(\d{1,2}(?:\.\d)?)\s*(?:size|waist|uk|us|eu)?\b/gi);
  for (const match of numericSizeMatches) {
    const num = match[1];
    const hasSizeContext = new RegExp(`\\b(?:size\\s*[:=]?\\s*${num}|${num}\\s*size|waist\\s*[:=]?\\s*${num}|${num}\\s*waist|uk\\s+${num}|us\\s+${num}|eu\\s+${num})\\b`, "i").test(qLower);
    if (hasSizeContext && !detectedSizes.includes(num)) {
      detectedSizes.push(num);
    }
  }

  // Standalone size check (e.g. "M tshirt" or "L size") if not already found
  if (detectedSizes.length === 0) {
    const standaloneMatch = qLower.match(/\b(xs|s|m|l|xl|xxl|3xl)\b(?:\s+(?:t-?shirt|shirt|pants|dress|shoes|size))?/i);
    if (standaloneMatch && ["m", "s", "l", "xl", "xs", "xxl", "3xl"].includes(standaloneMatch[1].toLowerCase())) {
      detectedSizes.push(standaloneMatch[1].toUpperCase());
    }
  }

  // Negation check: e.g. "does not have M size", "don't have size 10", "no black color"
  const isNegatedSize = /\b(?:does\s+not|doesn't|don't|no|not|without|out\s+of)\s+have\b.*\b(?:size|sizes)\b|\b(?:no|not)\s+(?:size|sizes)\b/i.test(qLower);

  const filteredSizes = isNegatedSize ? [] : detectedSizes;

  // Comparison intent detection ("vs", "compare", "difference between", "better than")
  const isComparison = /\b(compare|versus|\bvs\b|difference between|differ|better than|which is better|which one to buy)\b/i.test(qLower);

  let comparisonEntities = [];
  if (isComparison) {
    // Try splitting by vs / compare
    if (/\bvs\b/i.test(qLower)) {
      const parts = qLower.split(/\bvs\b/i).map(p => p.replace(/^(compare|difference between|\s)+/i, "").trim()).filter(Boolean);
      if (parts.length >= 2) comparisonEntities = parts.slice(0, 3);
    } else if (/compare\b/i.test(qLower)) {
      const afterCompare = qLower.replace(/^.*?\bcompare\b/i, "").trim();
      const parts = afterCompare.split(/\s+(?:and|with|to|vs)\s+/i).map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) comparisonEntities = parts.slice(0, 3);
    } else if (/difference between\b/i.test(qLower)) {
      const afterDiff = qLower.replace(/^.*?\bdifference between\b/i, "").trim();
      const parts = afterDiff.split(/\s+(?:and|with)\s+/i).map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) comparisonEntities = parts.slice(0, 3);
    }
  }

  // Build clean search query for vector search (strips conversational fluff like "how can you say that it does have")
  let cleanSearchQuery = qLower
    .replace(/\b(how can you say that|how come|why do you say|this product does not have|does not have|how to buy|can you tell me if|i want to know if)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanSearchQuery || cleanSearchQuery.length < 3) {
    cleanSearchQuery = qLower;
  }

  return {
    maxPrice,
    minPrice,
    colors: detectedColors,
    sizes: filteredSizes,
    isComparison,
    comparisonEntities,
    cleanSearchQuery,
    confidence: (maxPrice !== null || detectedColors.length > 0 || filteredSizes.length > 0 || isComparison) ? "high" : "low"
  };
}

/**
 * Enterprise Two-Tier E-Commerce Query Parser.
 *
 * Runs Tier 1 (Fast RegEx) first. If high confidence, returns immediately.
 * If query is complex and low confidence, falls back to Tier 2 (LLM extraction) with safety timeout.
 *
 * @param {string} query
 * @param {object} options - { botId, sessionId }
 * @returns {Promise<object>} Extracted query parameters
 */
async function parseEcommerceQuery(query, options = {}) {
  if (!query || typeof query !== "string") {
    return { maxPrice: null, minPrice: null, colors: [], sizes: [], isComparison: false, comparisonEntities: [] };
  }

  // Tier 1: Fast RegEx (0ms, 0 cost)
  const tier1 = parseFastRegEx(query);

  // If Tier 1 identified clear constraints or comparison, use it directly (saves LLM tokens)
  if (tier1.confidence === "high") {
    console.log(`⚡ [E-Commerce Query Parser - Tier 1 Fast Path] Found: maxPrice=${tier1.maxPrice}, sizes=[${tier1.sizes.join(",")}], colors=[${tier1.colors.join(",")}], isComparison=${tier1.isComparison}`);
    return tier1;
  }

  // Check if query looks complex (e.g. contains words like "looking for", "suggest", "cheaper", "recommend")
  const isComplexQuery = /\b(looking for|suggest|recommend|cheaper|expensive|affordable|options|best|top)\b/i.test(query);
  if (!isComplexQuery) {
    return tier1; // Return clean empty/default result
  }

  // Tier 2: LLM-Assisted Constraint & Comparison Extractor
  try {
    console.log(`🧠 [E-Commerce Query Parser - Tier 2 LLM Path] Processing complex query: "${query}"`);
    const prompt = `Extract e-commerce product query filters and comparison entities from this message.
Return strictly valid JSON with no extra text or markdown formatting.
JSON Format:
{
  "maxPrice": number or null,
  "minPrice": number or null,
  "colors": array of color strings,
  "sizes": array of size strings (e.g. "S", "M", "L", "XL"),
  "isComparison": boolean,
  "comparisonEntities": array of 2-3 product name strings being compared
}
User Query: "${query.replace(/"/g, '\\"')}"`;

    const raw = await callOpenRouterChat({
      messages: [
        { role: "system", content: "You are a precise JSON query parameter extractor for e-commerce search." },
        { role: "user", content: prompt }
      ],
      temperature: 0,
      maxTokens: 120,
      operation: "ecommerce_query_parsing",
      botId: options.botId,
      sessionId: options.sessionId,
    });

    const cleanJson = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleanJson);

    return {
      maxPrice: typeof parsed.maxPrice === "number" ? parsed.maxPrice : tier1.maxPrice,
      minPrice: typeof parsed.minPrice === "number" ? parsed.minPrice : tier1.minPrice,
      colors: Array.isArray(parsed.colors) ? parsed.colors : tier1.colors,
      sizes: Array.isArray(parsed.sizes) ? parsed.sizes : tier1.sizes,
      isComparison: Boolean(parsed.isComparison || tier1.isComparison),
      comparisonEntities: Array.isArray(parsed.comparisonEntities) && parsed.comparisonEntities.length >= 2 ? parsed.comparisonEntities : tier1.comparisonEntities
    };
  } catch (err) {
    console.warn(`⚠️ [Query Parser Tier 2 Fallback] LLM parsing failed/skipped, using Tier 1 result:`, err.message);
    return tier1;
  }
}

module.exports = {
  parseFastRegEx,
  parseEcommerceQuery,
  COLOR_DICTIONARY,
  SIZE_DICTIONARY,
};
