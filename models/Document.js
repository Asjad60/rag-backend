const mongoose = require('mongoose');

const DocumentSchema = new mongoose.Schema({
  botId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bot', required: true },
  url: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  scrapedAt: { type: Date }
});

module.exports = mongoose.model('Document', DocumentSchema);
