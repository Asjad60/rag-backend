const Bot = require('../models/Bot');
const Document = require('../models/Document');
const AnalyticsLog = require('../models/AnalyticsLog');
const { scrapeAndStore, deleteCollection } = require('../services/scraperService');

exports.createBot = async (req, res) => {
  try {
    const { userId, name, businessName, description, websiteUrl, welcomeMessage, systemPrompt, colorScheme } = req.body;
    const bot = new Bot({
      userId,
      name,
      businessName:   businessName || '',
      description:    description || `AI assistant for ${websiteUrl || name}`,
      websiteUrl:     websiteUrl || '',
      welcomeMessage: welcomeMessage || `Hi! I'm the AI assistant for ${businessName || name}. Ask me anything!`,
      systemPrompt:   systemPrompt || '',
      colorScheme:    colorScheme || '#3B82F6',
    });
    await bot.save();
    res.status(201).json(bot);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getBots = async (req, res) => {
  try {
    const bots = await Bot.find({ userId: req.params.userId });
    res.json(bots);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getBot = async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.botId);
    if (!bot) return res.status(404).json({ message: 'Bot not found' });
    res.json(bot);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.ingestUrl = async (req, res) => {
  try {
    const { botId, url } = req.body;

    const bot = await Bot.findById(botId);
    if (!bot) return res.status(404).json({ message: 'Bot not found' });

    // If websiteUrl not set, derive it from the ingested URL
    if (!bot.websiteUrl) {
      try {
        const { URL } = require('url');
        const parsed = new URL(url);
        bot.websiteUrl = `${parsed.protocol}//${parsed.hostname}`;
      } catch (_) {
        bot.websiteUrl = url;
      }
      await bot.save();
    }

    // Create doc record
    const doc = new Document({ botId, url, status: 'processing' });
    await doc.save();

    // Background scraping — does NOT block the HTTP response
    scrapeAndStore(botId, url)
      .then(async (result) => {
        doc.status    = 'completed';
        doc.scrapedAt = new Date();
        await doc.save();

        // Auto-set businessName from scraped homepage title if not already set
        if (!bot.businessName && result.businessName) {
          bot.businessName  = result.businessName;
          bot.welcomeMessage = `Hi! I'm the AI assistant for ${result.businessName}. How can I help you today?`;
          await bot.save();
          console.log(`✅ Auto-set businessName="${result.businessName}" for bot ${botId}`);
        }
      })
      .catch(async (err) => {
        console.error('Ingestion failed:', err.message);
        doc.status = 'failed';
        await doc.save();
      });

    res.json({ message: 'Ingestion started', documentId: doc._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getDocuments = async (req, res) => {
  try {
    const docs = await Document.find({ botId: req.params.botId });
    res.json(docs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const LlmUsage = require('../models/LlmUsage');

exports.getBotUsage = async (req, res) => {
  try {
    const { botId } = req.params;
    const records = await LlmUsage.find({ botId }).sort({ timestamp: -1 });

    const totals = records.reduce(
      (acc, r) => {
        acc.inputTokens += r.inputTokens || 0;
        acc.outputTokens += r.outputTokens || 0;
        acc.cacheTokens += r.cacheTokens || 0;
        acc.inputCost += r.inputCost || 0;
        acc.outputCost += r.outputCost || 0;
        acc.cacheCost += r.cacheCost || 0;
        acc.totalCost += r.totalCost || 0;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, cacheTokens: 0, inputCost: 0, outputCost: 0, cacheCost: 0, totalCost: 0 }
    );

    res.json({
      botId,
      totalCalls: records.length,
      totals: {
        ...totals,
        inputCost: parseFloat(totals.inputCost.toFixed(6)),
        outputCost: parseFloat(totals.outputCost.toFixed(6)),
        cacheCost: parseFloat(totals.cacheCost.toFixed(6)),
        totalCost: parseFloat(totals.totalCost.toFixed(6)),
      },
      records,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * DELETE /api/bots/:botId
 *
 * Fully removes a bot and all its associated data:
 *   1. Drops the bot's Qdrant collection (bot_<botId>)
 *   2. Deletes all Document records for this bot
 *   3. Deletes all AnalyticsLog records for this bot
 *   4. Deletes all LlmUsage records for this bot
 *   5. Deletes the Bot document itself
 */
exports.deleteBot = async (req, res) => {
  try {
    const { botId } = req.params;

    const bot = await Bot.findById(botId);
    if (!bot) return res.status(404).json({ message: 'Bot not found' });

    // 1. Drop Qdrant collection (graceful if it doesn't exist yet)
    await deleteCollection(botId);

    // 2. Clean up MongoDB records
    await Document.deleteMany({ botId });
    await AnalyticsLog.deleteMany({ botId });
    await LlmUsage.deleteMany({ botId });
    await Bot.findByIdAndDelete(botId);

    console.log(`🗑️  Bot "${bot.name}" (${botId}) fully deleted`);
    res.json({ message: 'Bot deleted successfully' });
  } catch (error) {
    console.error('❌ Delete bot error:', error);
    res.status(500).json({ message: error.message });
  }
};
