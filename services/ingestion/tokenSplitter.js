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
 * Extracts trailing lines from a text chunk up to a maximum token budget for chunk overlap.
 */
function getTrailingOverlap(chunkText, overlapTokens) {
  if (!overlapTokens || overlapTokens <= 0 || !chunkText.trim()) return "";
  const lines = chunkText.trim().split("\n");
  let overlapText = "";
  let overlapCount = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const lineTokens = countTokens(line);
    if (overlapCount + lineTokens > overlapTokens && overlapText.length > 0) {
      break;
    }
    overlapText = line + "\n" + overlapText;
    overlapCount += lineTokens;
  }
  return overlapText;
}

/**
 * Splits text into chunks by token count using cl100k_base tokenizer.
 * Respects paragraph boundaries and applies sliding window token overlap.
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
    return [text.trim()];
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
        const overlap = getTrailingOverlap(currentChunk, overlapTokens);
        chunks.push(currentChunk.trim());
        currentChunk = overlap;
        currentTokens = countTokens(overlap);
      }
      const lines = para.split(/\n/);
      for (const line of lines) {
        const lineTokens = countTokens(line);
        if (currentTokens + lineTokens > maxTokens && currentChunk.trim()) {
          const overlap = getTrailingOverlap(currentChunk, overlapTokens);
          chunks.push(currentChunk.trim());
          currentChunk = (overlap ? overlap : "") + line + "\n";
          currentTokens = countTokens(currentChunk);
        } else {
          currentChunk += line + "\n";
          currentTokens += lineTokens;
        }
      }
      continue;
    }

    if (currentTokens + paraTokens > maxTokens && currentChunk.trim()) {
      const overlap = getTrailingOverlap(currentChunk, overlapTokens);
      chunks.push(currentChunk.trim());
      currentChunk = (overlap ? overlap : "") + para + "\n\n";
      currentTokens = countTokens(currentChunk);
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
 * Incorporates Document Structure (Tables, Code Blocks, QA Pairs) and Contextual Summary.
 *
 * @param {string} rawText           - Full page text
 * @param {string} contextualSummary - 50-100 token page summary
 * @param {object} metadata          - Additional page metadata
 * @param {Array}  structures        - Optional array of structural blocks from structureParser
 * @returns {{ parentChunks: object[], childChunks: object[] }}
 */
function createParentChildChunks(
  rawText,
  contextualSummary = "",
  metadata = {},
  structures = []
) {
  const enc = getTokenizer();

  const PARENT_TARGET_TOKENS = 850;
  const CHILD_TARGET_TOKENS = 180;
  const CHILD_OVERLAP_TOKENS = 30;

  // Use structural blocks if available, preserving tables and code blocks intact
  let sourceText = rawText;
  if (Array.isArray(structures) && structures.length > 0) {
    sourceText = structures
      .map((block) => {
        if (block.type === "code_block" || block.type === "table") {
          return `\n\n${block.content}\n\n`;
        }
        return block.content;
      })
      .join("\n\n");
  }

  // 1. Create Parent Chunks (800-1000 tokens)
  const parentRawTexts = splitByTokens(sourceText, PARENT_TARGET_TOKENS, 50);

  const parentChunks = [];
  const childChunks = [];

  parentRawTexts.forEach((pText, pIndex) => {
    const parentId = `parent_${pIndex}_${countTokens(pText)}`;
    const titlePrefix = metadata.pageTitle ? `[Page: ${metadata.pageTitle}]\n` : '';
    const pSummaryText = contextualSummary
      ? `${titlePrefix}[Document Context: ${contextualSummary}]\n\n${pText}`
      : `${titlePrefix}${pText}`;

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
        ? `${titlePrefix}[Document Context: ${contextualSummary}]\n\n${cText}`
        : `${titlePrefix}${cText}`;

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
