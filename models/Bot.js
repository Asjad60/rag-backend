const mongoose = require("mongoose");

const BotSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true },
  businessName: { type: String, default: "" },
  description: { type: String, default: "" },
  websiteUrl: { type: String, default: "" },
  welcomeMessage: {
    type: String,
    default: "Hi! I'm your AI assistant. Ask me anything about this website.",
  },
  systemPrompt: { type: String, default: "" },
  colorScheme: { type: String, default: "#3B82F6" },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Bot", BotSchema);
