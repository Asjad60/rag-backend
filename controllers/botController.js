const Bot = require('../models/Bot');
const Document = require('../models/Document');
const { scrapeAndStore } = require('../services/scraperService');

exports.createBot = async (req, res) => {
  try {
    const { userId, name, businessName, description, websiteUrl, welcomeMessage, systemPrompt, colorScheme } = req.body;
    const bot = new Bot({
      userId,
      name,
      businessName: businessName || '',
      description: description || `AI assistant for ${websiteUrl || name}`,
      websiteUrl: websiteUrl || '',
      welcomeMessage: welcomeMessage || `Hi! I'm the AI assistant for ${businessName || name}. Ask me anything!`,
      systemPrompt: systemPrompt || '',
      colorScheme: colorScheme || '#3B82F6',
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

    // If websiteUrl not set, use the ingested URL as the root website URL
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

    // Background scraping
    scrapeAndStore(botId, url)
      .then(async (result) => {
        doc.status = 'completed';
        doc.scrapedAt = new Date();
        await doc.save();

        // Auto-update businessName from scraped page title if not set
        if (!bot.businessName && result.businessName) {
          bot.businessName = result.businessName;
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
