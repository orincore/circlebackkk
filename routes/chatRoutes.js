const express = require('express');
const router = express.Router();
const { 
  getChats, 
  getChatById, 
  getChatMessages,    // legacy route; use getMessageHistory for pagination
  endRandomChat,
  initiateMatchmaking,  // Sets user status to 'searching'
  handleMessage,
  createChatSession,
  searchMessages,
  editMessage,
  deleteMessage,
  archiveChat,
  addReaction,
  handleBlockUser,
  getMessageHistory,   // Paginated message history endpoint
  handleTypingIndicator
} = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

// Apply auth middleware to all routes
router.use(protect);

// Chat routes
router.get('/', getChats); // Get all active chats for the authenticated user
router.get('/:chatId', getChatById); // Get specific chat details by ID
router.get('/:chatId/messages', getMessageHistory); // Get paginated chat messages
router.put('/:chatId/end', endRandomChat); // End an active chat session
router.put('/:chatId/archive', archiveChat); // Archive a chat

// Message routes
router.get('/:chatId/messages/search', searchMessages); // Search messages within a chat
router.post('/:chatId/messages', async (req, res) => {
  try {
    const { content } = req.body;
    const result = await handleMessage({
      chatId: req.params.chatId,
      senderId: req.user._id,
      content
    });
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error
      });
    }
    res.status(201).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});
router.put('/messages/:messageId', editMessage); // Edit a specific message
router.delete('/messages/:messageId', deleteMessage); // Delete a specific message
router.post('/messages/:messageId/reactions', addReaction); // Add a reaction to a message

// Matchmaking routes
router.post('/start-search', async (req, res) => {
  try {
    const result = await initiateMatchmaking(req.user._id);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error
      });
    }
    res.status(200).json({
      success: true,
      message: 'Search started',
      user: result.user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Chat session creation route (for direct chat creation based on mutual acceptance)
router.post('/create-session', async (req, res) => {
  try {
    const { participantId, chatType } = req.body;
    const result = await createChatSession(
      req.user._id,
      participantId,
      chatType || req.user.chatPreference
    );
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error
      });
    }
    res.status(201).json({
      success: true,
      chat: result.chat,
      isNew: result.isNew || true
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// User interaction routes
router.post('/block/:userId', handleBlockUser); // Block a user

// WebSocket routes (for typing indicator)
router.post('/:chatId/typing', (req, res) => {
  // Assuming req.io is injected via middleware in app.js
  handleTypingIndicator(req.io, req.params.chatId, req.user._id);
  res.status(200).json({ success: true });
});

module.exports = router;
