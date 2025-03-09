const express = require('express');
const router = express.Router();
const { 
  getChats,
  getChatById,
  getMessageHistory,
  endRandomChat,
  initiateMatchmaking,
  handleMessage,
  createChatSession,
  searchMessages,
  editMessage,
  deleteMessage,
  archiveChat,
  addReaction,
  handleBlockUser,
  handleTypingIndicator
} = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');
const Chat = require('../models/chatModel');

// Apply auth middleware to all routes
router.use(protect);

// ==================== Chat Routes ====================
router.get('/', getChats);
router.get('/:chatId', getChatById);
router.get('/:chatId/messages', getMessageHistory);
router.put('/:chatId/end', endRandomChat);
router.put('/:chatId/archive', archiveChat);

// ==================== Message Routes ====================
router.get('/:chatId/messages/search', searchMessages);

// Updated POST message route
router.post('/:chatId/messages', async (req, res) => {
  try {
    const io = req.app.get('io'); // Get the io instance from the app
    const { content } = req.body;
    const { chatId } = req.params;
    const senderId = req.user._id;

    // Validate input
    if (!content || !chatId || !senderId) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing required fields" 
      });
    }

    // Create message in database
    const message = await handleMessage({
      chatId,
      senderId,
      content
    });

    // Populate sender information
    const populatedMessage = await message.populate({
      path: 'sender',
      select: 'username avatar'
    });

    // Verify chat exists
    const chat = await Chat.findById(chatId);
    if (!chat) {
      return res.status(404).json({ 
        success: false, 
        error: "Chat not found" 
      });
    }

    // Broadcast message to room
    io.to(chatId).emit('new-message', populatedMessage);

    res.status(201).json({
      success: true,
      data: populatedMessage
    });

  } catch (error) {
    console.error('[POST MESSAGE ERROR]', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

router.put('/messages/:messageId', editMessage);
router.delete('/messages/:messageId', deleteMessage);
router.post('/messages/:messageId/reactions', addReaction);

// ==================== Matchmaking Routes ====================
router.post('/start-search', async (req, res) => {
  try {
    const io = req.app.get('io'); // Get the io instance from the app
    const result = await initiateMatchmaking(io, req.user._id);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.status(200).json({
      success: true,
      data: result.user,
      message: 'Matchmaking started'
    });

  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

router.post('/create-session', async (req, res) => {
  try {
    const io = req.app.get('io'); // Get the io instance from the app
    const { participantId, chatType = 'random' } = req.body;

    const result = await createChatSession(
      io,
      req.user._id,
      participantId,
      chatType
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    const chat = await Chat.findById(result.chatId)
      .populate('participants', 'username avatar');

    res.status(201).json({
      success: true,
      data: chat,
      message: 'Chat session created'
    });

  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==================== User Interaction Routes ====================
router.post('/block/:userId', handleBlockUser);

// ==================== WebSocket Enhanced Routes ====================
router.post('/:chatId/typing', (req, res) => {
  try {
    const io = req.app.get('io'); // Get the io instance from the app
    const { chatId } = req.params;
    const userId = req.user._id;

    handleTypingIndicator(io, chatId, userId);

    res.status(200).json({ 
      success: true 
    });

  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;
