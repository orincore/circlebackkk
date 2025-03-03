const Chat = require('../models/chatModel');
const Message = require('../models/messageModel');
const User = require('../models/userModel');
const mongoose = require('mongoose');

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
