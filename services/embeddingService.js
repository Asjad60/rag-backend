const axios = require('axios');

const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIM = 1536;

/**
 * Generates a 1536-dim embedding vector using OpenRouter's OpenAI-compatible
 * embeddings endpoint (text-embedding-3-small).
 * @param {string} text - The text to embed.
 * @returns {Promise<number[]>} - The embedding vector.
 */
async function generateEmbeddings(text) {
  try {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) throw new Error('OPENROUTER_API_KEY is not set');

    const response = await axios.post(
      'https://openrouter.ai/api/v1/embeddings',
      {
        model: EMBEDDING_MODEL,
        input: text,
      },
      {
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'RAG Chatbot SaaS',
        },
      }
    );

    const vector = response.data.data[0].embedding;
    if (!vector || vector.length !== EMBEDDING_DIM) {
      throw new Error(
        `Unexpected embedding dimension: got ${vector?.length}, expected ${EMBEDDING_DIM}`
      );
    }
    return vector;
  } catch (error) {
    console.error(
      'Embedding error:',
      error.response ? JSON.stringify(error.response.data) : error.message
    );
    throw new Error('Failed to generate embedding');
  }
}

module.exports = { generateEmbeddings, EMBEDDING_DIM };
