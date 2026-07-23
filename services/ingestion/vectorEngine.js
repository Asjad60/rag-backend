const crypto = require('crypto');
const { generateEmbeddings } = require('../embeddingService');

/**
 * Stage L: Generate Deterministic SHA-256 UUID (URL + Index + Hash).
 * Formats a SHA-256 hash into a valid RFC-4122 UUID v4/v5 format string
 * so Qdrant point IDs are 100% deterministic and idempotent.
 *
 * @param {string} url       - Page URL
 * @param {string} indexId   - Chunk index ID (e.g., 'parent_0' or '0_1')
 * @param {string} textHash  - Hash of chunk text
 * @returns {string}         - 36-char valid UUID string
 */
function generateDeterministicUUID(url, indexId, textHash) {
  const seed = `${url}::${indexId}::${textHash}`;
  const sha256Hex = crypto.createHash('sha256').update(seed).digest('hex');

  // Format sha256Hex into 8-4-4-4-12 UUID layout
  const part1 = sha256Hex.substring(0, 8);
  const part2 = sha256Hex.substring(8, 12);
  // Set version to 4 (uuid)
  const part3 = '4' + sha256Hex.substring(13, 16);
  // Set variant to RFC4122
  const variantHex = (parseInt(sha256Hex.substring(16, 17), 16) & 0x3 | 0x8).toString(16);
  const part4 = variantHex + sha256Hex.substring(17, 20);
  const part5 = sha256Hex.substring(20, 32);

  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

/**
 * Stage K: Generate Sparse Vector (BM25 Index Tokens).
 * Builds a term frequency sparse vector representation of the text for hybrid search.
 *
 * @param {string} text - Chunk text
 * @returns {{ indices: number[], values: number[] }}
 */
function generateSparseVector(text) {
  if (!text) return { indices: [], values: [] };

  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 2);

  const freqMap = {};
  tokens.forEach(token => {
    // Hash token string to a 32-bit uint index
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = (hash << 5) - hash + token.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }
    const index = Math.abs(hash) % 1_000_000;
    freqMap[index] = (freqMap[index] || 0) + 1;
  });

  const indices = [];
  const values = [];
  const totalTokens = tokens.length || 1;

  Object.entries(freqMap).forEach(([idxStr, count]) => {
    indices.push(parseInt(idxStr, 10));
    // BM25 term frequency term weight
    const tf = count / totalTokens;
    values.push(parseFloat(tf.toFixed(4)));
  });

  return { indices, values };
}

/**
 * Stage I: Vectorization Engine.
 * Vectorizes a batch of child chunks: generates 1536-dim dense embeddings,
 * BM25 sparse vectors, and deterministic UUIDs.
 *
 * @param {object[]} childChunks - Array of child chunk objects
 * @param {string} url           - Page URL
 * @returns {Promise<object[]>}   - Array of Qdrant point objects
 */
async function vectorizeChunks(childChunks, url, options = {}) {
  if (!childChunks || childChunks.length === 0) return [];

  // Extract texts to embed
  const textsToEmbed = childChunks.map(c => c.contextualText || c.text);

  // Generate 1536-dim dense embeddings in batch via OpenRouter
  const denseEmbeddings = await generateEmbeddings(textsToEmbed, {
    botId: options.botId,
    operation: 'dense_embedding',
  });

  const points = childChunks.map((chunk, i) => {
    const denseVector = Array.isArray(denseEmbeddings[0]) ? denseEmbeddings[i] : denseEmbeddings;
    const sparseVector = generateSparseVector(chunk.contextualText || chunk.text);
    const textHash = crypto.createHash('sha256').update(chunk.text).digest('hex');

    const pointId = generateDeterministicUUID(url, chunk.childIndex, textHash);

    return {
      id: pointId,
      vector: denseVector, // 1536-dim dense vector
      sparse_vector: sparseVector,
      payload: {
        url,
        childIndex: chunk.childIndex,
        parentId: chunk.parentId,
        text: chunk.text,
        parentText: chunk.parentText,
        contextualText: chunk.contextualText,
        pageTitle: chunk.pageTitle || '',
        pageType: chunk.pageType || 'general_page',
        contactEmails: chunk.contactEmails || [],
        contactPhones: chunk.contactPhones || [],
        tokenCount: chunk.tokenCount || 0,
      },
    };
  });

  return points;
}

module.exports = {
  generateDeterministicUUID,
  generateSparseVector,
  vectorizeChunks,
};
