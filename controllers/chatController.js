const Chat = require('../models/chatModel');
const Message = require('../models/messageModel');
const User = require('../models/userModel');
const Block = require('../models/blockModel');
const mongoose = require('mongoose');

// Track pending matches with expiration (2 minutes)
const pendingMatches = new Map();

// Get all active chats for a user
const getChats = async (req, res) => {
  try {
    const chats = await Chat.find({
      participants: req.user._id,
      isActive: true
    })
      .populate({
        path: 'participants',
        select: 'firstName lastName username profileCreatedAt interests gender location online chatStatus'
      })
      .populate({
        path: 'lastMessage',
        select: 'content sender createdAt readBy'
      })
      .sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      count: chats.length,
      data: chats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get single chat by ID with participant details
const getChatById = async (req, res) => {
  try {
    const chat = await Chat.findOne({
      _id: req.params.chatId,
      participants: req.user._id,
      isActive: true
    })
      .populate({
        path: 'participants',
        select: 'firstName lastName username profileCreatedAt interests gender location online chatStatus'
      });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    res.status(200).json({
      success: true,
      data: chat
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Create new chat session with mutual acceptance (pending match)
const createChatSession = async (user1Id, user2Id, chatType) => {
  try {
    // Check for an existing pending match between these users
    const existingMatch = Array.from(pendingMatches.values()).find(match =>
      match.users.includes(user1Id) && match.users.includes(user2Id)
    );
    if (existingMatch) return { success: true, chatId: existingMatch.chatId };

    // Create new pending match with acceptances and rejections arrays
    const chatId = new mongoose.Types.ObjectId().toString();
    pendingMatches.set(chatId, {
      users: [user1Id, user2Id],
      chatId,
      acceptances: [],
      rejections: [],
      expiresAt: Date.now() + 120000 // 2 minutes expiration
    });

    // Set expiration timer
    setTimeout(() => {
      if (pendingMatches.has(chatId)) {
        pendingMatches.delete(chatId);
      }
    }, 120000);

    return { success: true, chatId };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Handle match acceptance
const handleMatchAcceptance = async (chatId, userId) => {
  try {
    const match = pendingMatches.get(chatId);
    if (!match) return { success: false, error: 'Match expired' };

    // Prevent duplicate responses
    if (match.acceptances.includes(userId) || match.rejections.includes(userId)) {
      return { success: true, status: 'pending' };
    }

    match.acceptances.push(userId);
    pendingMatches.set(chatId, match);

    if (match.acceptances.length === 2) {
      const chat = await Chat.create({
        participants: match.users,
        chatType: 'random',
        isActive: true
      });

      // Update user statuses
      await User.updateMany(
        { _id: { $in: match.users } },
        { 
          chatStatus: 'in_chat',
          online: true,
          $addToSet: { activeChats: chat._id }
        },
        { new: true, runValidators: true }
      );

      // Get user data for socket emission
      const userA = await User.findById(match.users[0]);
      const userB = await User.findById(match.users[1]);

      // Retrieve socket IDs from activeUsers
      const userASocket = activeUsers.get(match.users[0])?.socketId;
      const userBSocket = activeUsers.get(match.users[1])?.socketId;

      // Emit match-confirmed to both users
      if (userASocket) {
        io.to(userASocket).emit('match-confirmed', {
          chatId: chat._id,
          partner: userB
        });
      }
      if (userBSocket) {
        io.to(userBSocket).emit('match-confirmed', {
          chatId: chat._id,
          partner: userA
        });
      }

      pendingMatches.delete(chatId);
      return { success: true, chat };
    }

    return { success: true, status: 'pending' };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Handle match rejection
const handleMatchRejection = async (chatId, userId) => {
  try {
    const match = pendingMatches.get(chatId);
    if (!match) return { success: false, error: 'Match expired' };

    // Prevent duplicate responses
    if (match.rejections.includes(userId) || match.acceptances.includes(userId)) {
      return { success: true, status: 'pending' };
    }

    match.rejections.push(userId);
    pendingMatches.set(chatId, match);

    // Update status to pending until both respond
    await User.updateMany(
      { _id: { $in: match.users } },
      { chatStatus: 'pending' }
    );

    const totalResponses = match.acceptances.length + match.rejections.length;
    if (totalResponses < 2) {
      return { success: true, status: 'pending' };
    } else {
      // At least one rejection => match denied
      await User.updateMany(
        { _id: { $in: match.users } },
        { chatStatus: 'online' }
      );
      pendingMatches.delete(chatId);
      return { success: false, status: 'rejected' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Enhanced message handler with read receipts
const handleMessage = async ({ chatId, senderId, content }) => {
  try {
    // Validate chat status
    const chat = await Chat.findById(chatId);
    if (!chat?.isActive) {
      return { success: false, error: 'Chat is not active' };
    }

    const newMessage = await Message.create({
      chat: chatId,
      sender: senderId,
      content,
      readBy: [senderId]
    });

    const populatedMessage = await Message.findById(newMessage._id)
      .populate({
        path: 'sender',
        select: 'firstName lastName username'
      });

    const updatedChat = await Chat.findByIdAndUpdate(
      chatId,
      {
        lastMessage: newMessage._id,
        $inc: { unreadCount: 1 }
      },
      { new: true }
    );

    return {
      success: true,
      message: populatedMessage,
      chat: updatedChat,
      receiverId: updatedChat.participants.find(id => !id.equals(senderId))
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Enhanced matchmaking initialization
const initiateMatchmaking = async (userId) => {
  try {
    const user = await User.findByIdAndUpdate(
      userId,
      {
        online: true,
        chatStatus: 'searching',
        lastActive: Date.now()
      },
      { new: true }
    );

    // Prevent duplicate searches
    if (user.chatStatus === 'in_chat') {
      return {
        success: false,
        error: 'User already in active chat'
      };
    }

    return {
      success: true,
      user: {
        id: user._id,
        interests: user.interests.map(i => i.toLowerCase().trim()),
        chatPreference: user.chatPreference
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Get messages for a chat with read receipts
const getChatMessages = async (req, res) => {
  try {
    const chat = await Chat.findOne({
      _id: req.params.chatId,
      participants: req.user._id,
      isActive: true
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    const messages = await Message.find({ chat: req.params.chatId })
      .populate({
        path: 'sender',
        select: 'firstName lastName username'
      })
      .sort({ createdAt: 1 });

    // Mark messages as read
    await Message.updateMany(
      {
        chat: req.params.chatId,
        sender: { $ne: req.user._id },
        readBy: { $ne: req.user._id }
      },
      { $push: { readBy: req.user._id } }
    );

    res.status(200).json({
      success: true,
      count: messages.length,
      data: messages
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// End chat and notify participants
const endRandomChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id;
    const chat = await Chat.findOneAndUpdate(
      {
        _id: chatId,
        participants: userId,
        isActive: true
      },
      { isActive: false },
      { new: true }
    ).populate('participants');

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found or already ended'
      });
    }

    // Update user statuses back to online
    await User.updateMany(
      { _id: { $in: chat.participants } },
      { $set: { chatStatus: 'online' } }
    );

    res.status(200).json({
      success: true,
      message: 'Chat ended successfully',
      data: chat
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const searchMessages = async (req, res) => {
    try {
      const { query } = req.query;
      const messages = await Message.find({
        chat: req.params.chatId,
        content: { $regex: query, $options: 'i' }
      })
        .populate('sender', 'username')
        .limit(50);
  
      res.status(200).json({
        success: true,
        count: messages.length,
        data: messages
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };
  
  const editMessage = async (req, res) => {
    try {
      const message = await Message.findOneAndUpdate(
        { _id: req.params.messageId, sender: req.user._id },
        { content: req.body.content, edited: true },
        { new: true }
      ).populate('sender', 'username');
  
      if (!message)
        return res.status(404).json({ success: false, message: 'Message not found' });
  
      res.status(200).json({ success: true, data: message });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };
  
  const deleteMessage = async (req, res) => {
    try {
      const message = await Message.findOneAndDelete({
        _id: req.params.messageId,
        sender: req.user._id
      });
  
      if (!message)
        return res.status(404).json({ success: false, message: 'Message not found' });
  
      res.status(200).json({ success: true, message: 'Message deleted' });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };
  
  const archiveChat = async (req, res) => {
    try {
      const chat = await Chat.findOneAndUpdate(
        { _id: req.params.chatId, participants: req.user._id },
        { isArchived: true },
        { new: true }
      );
      res.status(200).json({ success: true, data: chat });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };
  
  const addReaction = async (req, res) => {
    try {
      const { messageId } = req.params;
      const { emoji } = req.body;
      const message = await Message.findByIdAndUpdate(
        messageId,
        { $push: { reactions: { emoji, userId: req.user._id } } },
        { new: true }
      ).populate('sender', 'username avatar');
  
      if (!message) {
        return res.status(404).json({
          success: false,
          message: 'Message not found'
        });
      }
  
      res.status(200).json({
        success: true,
        data: message
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };
  
  // Updated getChatMessages with pagination
  const getMessageHistory = async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;
      const messages = await Message.find({ chat: req.params.chatId })
        .skip(skip)
        .limit(limit)
        .populate('sender', 'username')
        .sort({ createdAt: -1 });
  
      res.status(200).json({
        success: true,
        count: messages.length,
        page,
        totalPages: Math.ceil(await Message.countDocuments({ chat: req.params.chatId }) / limit),
        data: messages
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };
  
  // --- NEW: Handle typing indicator ---
  // This function emits a "typing" event to all clients in the specified chat room.
  const handleTypingIndicator = (io, chatId, userId) => {
    io.to(chatId).emit('typing', { chatId, userId });
  };
  
// Other functions (searchMessages, editMessage, deleteMessage, archiveChat, addReaction, getMessageHistory, handleTypingIndicator, handleBlockUser)
// ... (keep the existing implementations for these functions)

module.exports = {
  getChats,
  getChatById,
  createChatSession,
  handleMatchAcceptance,
  handleMatchRejection,
  handleMessage,
  initiateMatchmaking,
  getChatMessages,
  endRandomChat,
  searchMessages,
  editMessage,
  deleteMessage,
  archiveChat,
  addReaction,
  getMessageHistory,
  handleTypingIndicator,
  handleBlockUser: (req, res) => {
      // Simple block user implementation
      Block.create({
        blocker: req.user._id,
        blocked: req.params.userId
      })
        .then(() => res.status(200).json({ success: true, message: 'User blocked' }))
        .catch((error) => res.status(500).json({ success: false, message: error.message }));
    }
};
