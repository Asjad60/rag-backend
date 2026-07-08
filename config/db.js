require('dotenv').config();
const mongoose = require('mongoose');
const { QdrantClient } = require('@qdrant/js-client-rest');

// MongoDB Connection
const connectMongo = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/rag_chatbot';
    await mongoose.connect(mongoUri);
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
};

// Qdrant Connection
const qdrantUrl = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const qdrantClient = new QdrantClient({ url: qdrantUrl, apiKey: process.env.QDRANT_API_KEY });

const checkQdrant = async () => {
  try {
    // try to list collections just to check connection
    await qdrantClient.getCollections();
    console.log('✅ Qdrant connected');
  } catch (error) {
    console.log('⚠️ Qdrant connection error (ensure Qdrant is running):', error.message);
  }
};

module.exports = { connectMongo, qdrantClient, checkQdrant };
