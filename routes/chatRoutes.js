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
const Chat = require('../models/chatModel'); // Added missing Chat model import

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
router.post('/:chatId/messages', async (req, res) => {
  try {
    const io = req.app.get('socketio');
    const result = await handleMessage(io, {
      chatId: req.params.chatId,
      senderId: req.user._id,
      content: req.body.content
    });
    
    result.success 
      ? res.status(201).json(result)
      : res.status(400).json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.put('/messages/:messageId', editMessage);
router.delete('/messages/:messageId', deleteMessage);
router.post('/messages/:messageId/reactions', addReaction);

// ==================== Matchmaking Routes ====================
router.post('/start-search', async (req, res) => {
  try {
    const io = req.app.get('socketio'); // Get io instance
    const result = await initiateMatchmaking(io, req.user._id); // Pass io to controller
    
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
      message: error.message
    });
  }
});

router.post('/create-session', async (req, res) => {
  try {
    const io = req.app.get('socketio'); // Get io instance
    const result = await createChatSession(
      io, // Pass io to controller
      req.user._id,
      req.body.participantId,
      req.body.chatType || 'random'
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
      message: error.message
    });
  }
});

// ==================== User Interaction Routes ====================
router.post('/block/:userId', handleBlockUser);

// ==================== WebSocket Enhanced Routes ====================
router.post('/:chatId/typing', (req, res) => {
  try {
    const io = req.app.get('socketio');
    handleTypingIndicator(io, req.params.chatId, req.user._id);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
});

module.exports = router;
