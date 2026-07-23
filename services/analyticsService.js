const AnalyticsLog = require("../models/AnalyticsLog");

/**
 * Stage 6 — Analytics Log
 *
 * Writes a chat analytics event to MongoDB.
 * Returns the new document's _id so the client can later submit feedback.
 *
 * This function is intentionally async (not fire-and-forget) so the `logId`
 * can be included in the API response. The MongoDB write is fast (~5–20 ms)
 * and does not meaningfully add to total latency after the LLM call.
 *
 * @param {object}  data
 * @param {*}       data.botId            - Bot's MongoDB ObjectId
 * @param {string}  [data.sessionId]      - Client-supplied session identifier
 * @param {string}  [data.detectedLang]   - ISO 639-3 code
 * @param {boolean} [data.isNonEnglish]
 * @param {string}  [data.intent]         - Detailed intent sub-label
 * @param {string}  [data.ragPath]        - 'semantic'|'structured'|'clarify'|'greeting'|'none'
 * @param {string}  [data.queryText]      - Original user message
 * @param {string}  [data.translatedQuery]- English query used for retrieval
 * @param {string}  [data.replyText]      - Final reply sent to user
 * @param {number}  [data.chunksRetrieved]
 * @param {boolean} [data.guardrailFired]
 * @returns {Promise<string|null>}         - MongoDB _id string, or null on error
 */
async function logChatEvent(data) {
  try {
    const log = await AnalyticsLog.create(data);
    return log._id.toString();
  } catch (err) {
    // Analytics errors must NEVER break the chat flow
    console.error("⚠️  Analytics log error (non-fatal):", err.message);
    return null;
  }
}

/**
 * Updates the user's thumbs feedback on an existing analytics log entry.
 * Called by the POST /api/chat/feedback endpoint.
 *
 * @param {string}         logId   - MongoDB _id of the AnalyticsLog document
 * @param {'up'|'down'}    thumbs
 * @returns {Promise<AnalyticsLog|null>}
 */
async function updateFeedback(logId, thumbs) {
  return AnalyticsLog.findByIdAndUpdate(
    logId,
    { feedback: thumbs },
    { new: true },
  );
}

module.exports = { logChatEvent, updateFeedback };
