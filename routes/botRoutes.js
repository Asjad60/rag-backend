const express = require('express');
const { createBot, getBots, getBot, ingestUrl, getDocuments, getBotUsage, deleteBot } = require('../controllers/botController');
const router = express.Router();

router.post('/',                  createBot);
router.get('/user/:userId',       getBots);
router.post('/ingest',            ingestUrl);
router.get('/:botId',             getBot);
router.get('/:botId/documents',   getDocuments);
router.get('/:botId/usage',       getBotUsage);
router.delete('/:botId',          deleteBot);

module.exports = router;
