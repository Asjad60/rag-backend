const Bot = require('../models/Bot');
const mongoose = require('mongoose');
const { generateEmbeddings } = require('../services/embeddingService');
const { generateChatResponse, detectIntent, augmentQuery } = require('../services/llmService');
const { qdrantClient } = require('../config/db');

const COLLECTION_NAME = 'documents';

// Page type filters for intent-specific retrieval
const INTENT_PAGE_TYPE_FILTER = {
  contact:    ['contact_page'],
  about:      ['about_page', 'homepage'],
  product:    ['product_page', 'service_page', 'homepage'],
  pricing:    ['pricing_page', 'product_page'],
  navigation: [], // no filter — search everything
  faq:        ['faq_page'],
  general:    [],
};

exports.chat = async (req, res) => {
  try {
    const { botId, message, chatHistory = [] } = req.body;

    // ── Validate botId ──────────────────────────────────────────────────────
    if (!botId || !mongoose.isValidObjectId(botId)) {
      return res.status(400).json({ message: 'Invalid or missing botId' });
    }

    const bot = await Bot.findById(botId);
    if (!bot) return res.status(404).json({ message: 'Bot not found' });

    // ── Handle greeting with no RAG needed ─────────────────────────────────
    const intent = detectIntent(message);
    if (intent === 'greeting') {
      const greeting = bot.welcomeMessage ||
        `Hi! I'm the AI assistant for ${bot.businessName || 'this website'}. How can I help you today?`;
      return res.json({ reply: greeting, intent });
    }

    // ── Augment the query for better recall ────────────────────────────────
    const augmentedQuery = augmentQuery(message, intent);

    // ── Embed the query ────────────────────────────────────────────────────
    const queryVector = await generateEmbeddings(augmentedQuery);

    // ── Build Qdrant filter ────────────────────────────────────────────────
    const allowedPageTypes = INTENT_PAGE_TYPE_FILTER[intent] || [];
    const mustFilters = [
      { key: 'botId', match: { value: botId.toString() } },
    ];
    if (allowedPageTypes.length > 0) {
      mustFilters.push({
        key: 'pageType',
        match: { any: allowedPageTypes },
      });
    }

    // ── Search Qdrant ───────────────────────────────────────────────────────
    let contextText = '';
    let searchResults = [];
    try {
      searchResults = await qdrantClient.search(COLLECTION_NAME, {
        vector: queryVector,
        limit: 8,
        filter: { must: mustFilters },
        with_payload: true,
      });

      // If we got no results with page-type filter, fall back to unfiltered search
      if (searchResults.length === 0 && allowedPageTypes.length > 0) {
        console.log(`⚠️  No results with page-type filter [${allowedPageTypes}]. Falling back to full search.`);
        searchResults = await qdrantClient.search(COLLECTION_NAME, {
          vector: queryVector,
          limit: 8,
          filter: { must: [{ key: 'botId', match: { value: botId.toString() } }] },
          with_payload: true,
        });
      }

      // Format context with source metadata for richer LLM grounding
      contextText = searchResults
        .map((r) => {
          const { pageTitle, url, pageType, contactEmails, contactPhones, text } = r.payload;
          let header = `[Source: ${pageTitle || url} (${pageType})]`;
          let contactBlock = '';
          if (contactEmails?.length) contactBlock += `Emails: ${contactEmails.join(', ')}\n`;
          if (contactPhones?.length) contactBlock += `Phones: ${contactPhones.join(', ')}\n`;
          return `${header}\n${contactBlock}${text}`;
        })
        .join('\n\n---\n\n');

    } catch (e) {
      console.error('Qdrant search error:', e.message);
      // Continue with empty context — LLM will give a graceful fallback
    }

    // ── Append current message to history ──────────────────────────────────
    const fullHistory = [...chatHistory, { role: 'user', content: message }];

    // ── Generate response ──────────────────────────────────────────────────
    const botMeta = {
      businessName:   bot.businessName,
      websiteUrl:     bot.websiteUrl,
      welcomeMessage: bot.welcomeMessage,
      systemPrompt:   bot.systemPrompt || '',
    };

    const reply = await generateChatResponse(botMeta, contextText, fullHistory, intent);

    return res.json({ reply, intent });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ message: 'Chat error', error: error.message });
  }
};
