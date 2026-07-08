const mongoose = require('mongoose');

const BotSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:           { type: String, required: true },
  businessName:   { type: String, default: '' },       // e.g. "Acme Corp" — auto-extracted or manually set
  description:    { type: String, default: '' },
  websiteUrl:     { type: String, default: '' },        // Root URL the bot is trained on
  welcomeMessage: { type: String, default: "Hi! I'm your AI assistant. Ask me anything about this website." },
  systemPrompt:   { type: String, default: '' },        // Optional advanced override
  colorScheme:    { type: String, default: '#3B82F6' },
  createdAt:      { type: Date, default: Date.now },
});

module.exports = mongoose.model('Bot', BotSchema);
