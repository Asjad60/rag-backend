const mongoose = require('mongoose');

const DocumentSchema = new mongoose.Schema({
  botId:             { type: mongoose.Schema.Types.ObjectId, ref: 'Bot', required: true },
  url:               { type: String, required: true },
  status:            { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'skipped'], default: 'pending' },
  skipReason:        { type: String, default: '' },
  contextualSummary: { type: String, default: '' },
  qualityMetrics:    {
    wordCount:       { type: Number, default: 0 },
    tableCount:      { type: Number, default: 0 },
    codeBlockCount:  { type: Number, default: 0 },
    headersCount:    { type: Number, default: 0 },
  },
  chunksCount: {
    parentChunks:    { type: Number, default: 0 },
    childChunks:     { type: Number, default: 0 },
  },
  scrapedAt:         { type: Date }
});

module.exports = mongoose.model('Document', DocumentSchema);
