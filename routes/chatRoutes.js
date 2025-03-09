const express = require('express');
const mongoose = require('mongoose');
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
  handleTypingIndicator,
  unarchiveChat,
  unblockUser,
  stopTypingIndicator,
  handleReadAll
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
    const { chatId } = req.params;
    
    if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) {
      return res.status(400).json({
        success: false,
        error: "Valid chat ID is required"
      });
    }

    const result = await handleMessage(
      req.app.get('io'),
      {
        chatId,
        senderId: req.user._id,
        content: req.body.content
      }
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.status(201).json({
      success: true,
      data: result.data,
      message: result.message
    });

  } catch (error) {
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
    const { participantId, chatType } = req.body;

    // Validation
    if (!participantId) {
      return res.status(400).json({
        success: false,
        error: "Participant ID is required"
      });
    }

    const result = await createChatSession(
      req.app.get('io'),
      req.user._id,
      participantId,
      chatType
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.status(201).json({
      success: true,
      data: result.data,
      message: result.message
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Additional Feature Routes ====================

// Unarchive chat route
router.put('/:chatId/unarchive', unarchiveChat);

// Unblock user route
router.post('/unblock/:userId', unblockUser);

// Stop typing indicator route (optional)
router.post('/:chatId/stop-typing', (req, res) => {
  try {
    const io = req.app.get('io');
    const { chatId } = req.params;
    const userId = req.user._id;
    stopTypingIndicator(io, chatId, userId);
    res.status(200).json({ success: true, message: "Stopped typing" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Read all messages route (optional)
router.post('/:chatId/read-all', async (req, res) => {
  try {
    const io = req.app.get('io');
    const { chatId } = req.params;
    const userId = req.user._id;
    const result = await handleReadAll(io, { chatId, userId });
    result.success
      ? res.status(200).json(result)
      : res.status(400).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
