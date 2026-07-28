const crypto = require("crypto");
const { generateEmbeddings } = require("../embeddingService");

/**
 * Generates deterministic SHA-256 UUID v4 format string for Qdrant point IDs.
 */
function generateDeterministicUUID(url, indexId, textHash) {
  const seed = `${url}::${indexId}::${textHash}`;
  const sha256Hex = crypto.createHash("sha256").update(seed).digest("hex");

  const part1 = sha256Hex.substring(0, 8);
  const part2 = sha256Hex.substring(8, 12);
  const part3 = "4" + sha256Hex.substring(13, 16);
  const variantHex = (
    (parseInt(sha256Hex.substring(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);
  const part4 = variantHex + sha256Hex.substring(17, 20);
  const part5 = sha256Hex.substring(20, 32);

  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

/**
 * Vectorizes child chunks into Qdrant point objects (Dense + Native BM25 Sparse).
 */
async function vectorizeChunks(childChunks, url, options = {}) {
  if (!childChunks || childChunks.length === 0) return [];

  const textsToEmbed = childChunks.map((c) => c.contextualText || c.text);

  const denseEmbeddings = await generateEmbeddings(textsToEmbed, {
    botId: options.botId,
    operation: "dense_embedding",
  });

  const points = childChunks.map((chunk, i) => {
    const denseVector = Array.isArray(denseEmbeddings[0])
      ? denseEmbeddings[i]
      : denseEmbeddings;

    const sparseVector = {
      text: chunk.contextualText || chunk.text,
      model: "Qdrant/bm25",
    };

    const textHash = crypto
      .createHash("sha256")
      .update(chunk.text)
      .digest("hex");
    const pointId = generateDeterministicUUID(url, chunk.childIndex, textHash);

    return {
      id: pointId,
      vector: {
        "": denseVector,
        sparse_vector: sparseVector,
      },
      payload: {
        url,
        childIndex: chunk.childIndex,
        parentId: chunk.parentId,
        text: chunk.text,
        parentText: chunk.parentText,
        contextualText: chunk.contextualText,
        pageTitle: chunk.pageTitle || "",
        pageType: chunk.pageType || "general_page",
        contactEmails: chunk.contactEmails || [],
        contactPhones: chunk.contactPhones || [],
        tokenCount: chunk.tokenCount || 0,
        priceNumeric: chunk.ecommerceMeta?.priceNumeric ?? null,
        currency: chunk.ecommerceMeta?.currency || "INR",
        colors: chunk.ecommerceMeta?.colors || [],
        sizes: chunk.ecommerceMeta?.sizes || [],
      },
    };
  });

  return points;
}

module.exports = {
  generateDeterministicUUID,
  vectorizeChunks,
};
