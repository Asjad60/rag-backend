const { getEncoding } = require('js-tiktoken');

let tokenizer = null;
function getTokenizer() {
  if (!tokenizer) {
    tokenizer = getEncoding('cl100k_base');
  }
  return tokenizer;
}

/**
 * Counts exact tokens using cl100k_base encoding.
 */
function countTokens(text) {
  if (!text) return 0;
  try {
    const enc = getTokenizer();
    return enc.encode(text).length;
  } catch (_) {
    // Fallback token estimation
    return Math.ceil(text.length / 4);
  }
}

/**
 * Splits text into chunks by token count using cl100k_base tokenizer.
 *
 * @param {string} text          - Input text to split
 * @param {number} maxTokens     - Maximum tokens per chunk
 * @param {number} overlapTokens - Token overlap between consecutive chunks
 * @returns {string[]}           - Array of text chunks
 */
function splitByTokens(text, maxTokens, overlapTokens = 0) {
  if (!text || !text.trim()) return [];

  const totalTokens = countTokens(text);
  if (totalTokens <= maxTokens) {
    return [text];
  }

  // Split into natural paragraph blocks to prevent cutting product/document cards mid-sentence
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let currentChunk = "";
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = countTokens(para);

    if (paraTokens > maxTokens) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
        currentTokens = 0;
      }
      const lines = para.split(/\n/);
      for (const line of lines) {
        const lineTokens = countTokens(line);
        if (currentTokens + lineTokens > maxTokens && currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = line + "\n";
          currentTokens = lineTokens;
        } else {
          currentChunk += line + "\n";
          currentTokens += lineTokens;
        }
      }
      continue;
    }

    if (currentTokens + paraTokens > maxTokens && currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      currentChunk = para + "\n\n";
      currentTokens = paraTokens;
    } else {
      currentChunk += para + "\n\n";
      currentTokens += paraTokens;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Stage G & H: Hierarchical Parent-Child Chunking Strategy.
 *
 * Parent Chunks: 800–1000 tokens (large context window for generation)
 * Child Chunks: 150–200 tokens (small context window for high vector similarity)
 *
 * Each chunk incorporates the Contextual Summary from Stage E (Anthropic Contextual Method).
 *
 * @param {string} rawText           - Full page text
 * @param {string} contextualSummary - 50-100 token page summary
 * @param {object} metadata          - Additional page metadata
 * @returns {{ parentChunks: object[], childChunks: object[] }}
 */
function createParentChildChunks(rawText, contextualSummary = '', metadata = {}) {
  const enc = getTokenizer();

  const PARENT_TARGET_TOKENS = 850;
  const CHILD_TARGET_TOKENS = 180;
  const CHILD_OVERLAP_TOKENS = 30;

  // 1. Create Parent Chunks (800-1000 tokens)
  const parentRawTexts = splitByTokens(rawText, PARENT_TARGET_TOKENS, 50);

  const parentChunks = [];
  const childChunks = [];

  parentRawTexts.forEach((pText, pIndex) => {
    const parentId = `parent_${pIndex}_${countTokens(pText)}`;
    const pSummaryText = contextualSummary
      ? `[Document Context: ${contextualSummary}]\n\n${pText}`
      : pText;

    const parentObj = {
      parentId,
      parentIndex: pIndex,
      text: pText,
      contextualText: pSummaryText,
      tokenCount: countTokens(pSummaryText),
      ...metadata,
    };
    parentChunks.push(parentObj);

    // 2. Create Child Chunks (150-200 tokens) from this Parent Chunk
    const childRawTexts = splitByTokens(pText, CHILD_TARGET_TOKENS, CHILD_OVERLAP_TOKENS);

    childRawTexts.forEach((cText, cIndex) => {
      const childSummaryText = contextualSummary
        ? `[Document Context: ${contextualSummary}]\n\n${cText}`
        : cText;

      const childObj = {
        childIndex: `${pIndex}_${cIndex}`,
        parentId,
        parentText: pText,
        text: cText,
        contextualText: childSummaryText,
        tokenCount: countTokens(childSummaryText),
        ...metadata,
      };
      childChunks.push(childObj);
    });
  });

  return { parentChunks, childChunks };
}

module.exports = {
  countTokens,
  splitByTokens,
  createParentChildChunks,
};
