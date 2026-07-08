require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connectMongo, checkQdrant } = require('./config/db');

const authRoutes = require('./routes/authRoutes');
const botRoutes = require('./routes/botRoutes');
const chatRoutes = require('./routes/chatRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/bots', botRoutes);
app.use('/api/chat', chatRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Init
const start = async () => {
  await connectMongo();
  await checkQdrant();
  
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
};

start();
