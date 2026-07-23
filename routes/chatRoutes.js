const express = require('express');
const { chat, chatFeedback } = require('../controllers/chatController');
const router = express.Router();

// POST /api/chat          — main chat endpoint (full 7-stage pipeline)
router.post('/', chat);

// POST /api/chat/feedback — submit thumbs up/down for a previous reply
router.post('/feedback', chatFeedback);

module.exports = router;
