const Chat = require('../models/chatModel');
const Message = require('../models/messageModel');
const User = require('../models/userModel');
const Block = require('../models/blockModel');
const mongoose = require('mongoose');

// Track pending matches with expiration (2 minutes)
const pendingMatches = new Map();

// Get all active chats for a user
exports.getChats = async (req, res) => {
  try {
    const chats = await Chat.find({
      participants: req.user._id,
      isActive: true
    })
    .populate({
      path: 'participants',
      select: 'firstName lastName username profileCreatedAt interests gender location online'
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
exports.getChatById = async (req, res) => {
  try {
    const chat = await Chat.findOne({
      _id: req.params.chatId,
      participants: req.user._id,
      isActive: true
    })
    .populate({
      path: 'participants',
      select: 'firstName lastName username profileCreatedAt interests gender location online'
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

// Create new chat session with mutual acceptance
exports.createChatSession = async (user1Id, user2Id, chatType) => {
  try {
    // Check existing pending match
    const existingMatch = Array.from(pendingMatches.values()).find(match => 
      match.users.includes(user1Id) && match.users.includes(user2Id)
    );

    if (existingMatch) return { success: true, chatId: existingMatch.chatId };

    // Create new pending match
    const chatId = new mongoose.Types.ObjectId().toString();
    pendingMatches.set(chatId, {
      users: [user1Id, user2Id],
      chatId,
      acceptances: [],
      expiresAt: Date.now() + 120000 // 2 minutes
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
exports.handleMatchAcceptance = async (chatId, userId) => {
  try {
    const match = pendingMatches.get(chatId);
    if (!match) return { success: false, error: 'Match expired' };

    // Add user to acceptances
    if (!match.acceptances.includes(userId)) {
      match.acceptances.push(userId);
      pendingMatches.set(chatId, match);
    }

    // If both accepted, create actual chat
    if (match.acceptances.length === 2) {
      const chat = await Chat.create({
        participants: match.users,
        chatType: 'random',
        isActive: true
      });

      // Update user statuses
      await User.updateMany(
        { _id: { $in: match.users } },
        { chatStatus: 'in_chat' }
      );

      pendingMatches.delete(chatId);
      return { success: true, chat };
    }

    return { success: true, status: 'pending' };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Handle match rejection
exports.handleMatchRejection = async (chatId, userId) => {
  try {
    const match = pendingMatches.get(chatId);
    if (!match) return { success: false, error: 'Match not found' };

    // Notify other user
    const otherUser = match.users.find(u => u.toString() !== userId.toString());
    return { 
      success: true, 
      notifiedUser: otherUser,
      chatId 
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Enhanced message handler with read receipts
exports.handleMessage = async ({ chatId, senderId, content }) => {
  try {
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
exports.initiateMatchmaking = async (userId) => {
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
exports.getChatMessages = async (req, res) => {
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
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// End chat and notify participants
exports.endRandomChat = async (req, res) => {
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

    // Update user statuses
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
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// WebSocket Handlers ---------------------------------------------------

// Initialize matchmaking search
exports.initiateMatchmaking = async (userId) => {
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

    return { 
      success: true, 
      user: {
        id: user._id,
        interests: user.interests,
        chatPreference: user.chatPreference
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Handle real-time messages
exports.handleMessage = async ({ chatId, senderId, content }) => {
  try {
    const newMessage = await Message.create({
      chat: chatId,
      sender: senderId,
      content
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

// Create new chat session
exports.createChatSession = async (user1Id, user2Id, chatType) => {
  try {
    // Check for existing active chat
    const existingChat = await Chat.findOne({
      participants: { $all: [user1Id, user2Id] },
      isActive: true
    });

    if (existingChat) {
      return {
        success: true,
        chat: existingChat,
        isNew: false
      };
    }

    const newChat = await Chat.create({
      participants: [user1Id, user2Id],
      chatType,
      isActive: true
    });

    await User.updateMany(
      { _id: { $in: [user1Id, user2Id] } },
      { chatStatus: 'in_chat' }
    );

    const populatedChat = await Chat.findById(newChat._id)
      .populate({
        path: 'participants',
        select: 'firstName lastName username profileCreatedAt interests gender location online'
      });

    return {
      success: true,
      chat: populatedChat,
      isNew: true
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// New Features
exports.searchMessages = async (req, res) => {
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

exports.editMessage = async (req, res) => {
  try {
    const message = await Message.findOneAndUpdate(
      { _id: req.params.messageId, sender: req.user._id },
      { content: req.body.content, edited: true },
      { new: true }
    ).populate('sender', 'username');

    if (!message) return res.status(404).json({ success: false, message: 'Message not found' });
    
    res.status(200).json({ success: true, data: message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteMessage = async (req, res) => {
  try {
    const message = await Message.findOneAndDelete({
      _id: req.params.messageId,
      sender: req.user._id
    });

    if (!message) return res.status(404).json({ success: false, message: 'Message not found' });
    
    res.status(200).json({ success: true, message: 'Message deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.archiveChat = async (req, res) => {
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

exports.addReaction = async (req, res) => {
  try {
    const message = await Message.findByIdAndUpdate(
      req.params.messageId,
      { $push: { reactions: {
        emoji: req.body.emoji,
        userId: req.user._id
      }}},
      { new: true }
    );
    
    res.status(200).json({ success: true, data: message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Updated getChatMessages with pagination
exports.getChatMessages = async (req, res) => {
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

// WebSocket Handlers
exports.handleTypingIndicator = (io, chatId, userId) => {
  io.to(chatId).emit('typing', { chatId, userId });
};

exports.handleBlockUser = async (req, res) => {
  try {
    await Block.create({
      blocker: req.user._id,
      blocked: req.params.userId
    });
    
    res.status(200).json({ success: true, message: 'User blocked' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get message history with pagination
exports.getMessageHistory = async (req, res) => {
  try {
    const { chatId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Verify chat exists and user is a participant
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user._id,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found or access denied',
      });
    }

    // Fetch messages with pagination
    const messages = await Message.find({ chat: chatId })
      .skip(skip)
      .limit(limit)
      .populate('sender', 'username avatar')
      .sort({ createdAt: -1 });

    // Mark messages as read
    await Message.updateMany(
      {
        chat: chatId,
        sender: { $ne: req.user._id },
        readBy: { $ne: req.user._id },
      },
      { $push: { readBy: req.user._id } }
    );

    res.status(200).json({
      success: true,
      count: messages.length,
      page,
      totalPages: Math.ceil(await Message.countDocuments({ chat: chatId }) / limit),
      data: messages,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Search messages within a chat
exports.searchMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { query } = req.query;

    // Verify chat exists and user is a participant
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user._id,
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found or access denied',
      });
    }

    // Search messages by content
    const messages = await Message.find({
      chat: chatId,
      content: { $regex: query, $options: 'i' },
    })
      .populate('sender', 'username avatar')
      .limit(50);

    res.status(200).json({
      success: true,
      count: messages.length,
      data: messages,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Add reaction to a message
exports.addReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;

    // Verify message exists
    const message = await Message.findByIdAndUpdate(
      messageId,
      {
        $push: { reactions: { emoji, userId: req.user._id } },
      },
      { new: true }
    ).populate('sender', 'username avatar');

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found',
      });
    }

    res.status(200).json({
      success: true,
      data: message,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
