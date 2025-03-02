const express = require('express');
const router = express.Router();
const { 
  getChats, 
  getChatById, 
  getChatMessages, 
  findRandomMatch,
  endRandomChat
} = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

// Apply auth middleware to all routes
router.use(protect);

// Chat routes
router.get('/', getChats);
router.get('/match', findRandomMatch);
router.get('/:chatId', getChatById);
router.get('/:chatId/messages', getChatMessages);
router.put('/:chatId/end', endRandomChat);

module.exports = router;