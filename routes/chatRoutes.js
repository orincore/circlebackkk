const express = require('express');
const router = express.Router();
const { 
  getChats, 
  getChatById, 
  getMessageHistory, // Use getMessageHistory instead of getChatMessages
  endRandomChat,
  initiateMatchmaking,
  handleMessage,
  createChatSession,
  searchMessages,
  editMessage,
  deleteMessage,
  archiveChat,
  addReaction,
  handleTypingIndicator,
  handleBlockUser
} = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

// Apply auth middleware to all routes
router.use(protect);

// Chat routes
router.get('/', getChats); // Get all active chats
router.get('/:chatId', getChatById); // Get specific chat details
router.get('/:chatId/messages', getMessageHistory); // Get chat messages with pagination
router.put('/:chatId/end', endRandomChat); // End a chat session

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

// Message handling route
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

// New Routes
router.get('/:chatId/search', searchMessages); // Search messages within a chat
router.put('/messages/:messageId', editMessage); // Edit a message
router.delete('/messages/:messageId', deleteMessage); // Delete a message
router.put('/:chatId/archive', archiveChat); // Archive a chat
router.post('/messages/:messageId/reactions', addReaction); // Add reaction to a message
router.post('/block/:userId', handleBlockUser); // Block a user

// WebSocket routes
router.post('/:chatId/typing', (req, res) => {
  handleTypingIndicator(req.io, req.params.chatId, req.user._id);
  res.status(200).json({ success: true });
});

// Chat session creation route
router.post('/create-session', async (req, res) => {
  try {
    const { participantId } = req.body;
    const result = await createChatSession(
      req.user._id,
      participantId,
      req.user.chatPreference
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
      isNew: result.isNew
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;
