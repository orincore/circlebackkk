const Chat = require('../models/chatModel');
const Message = require('../models/messageModel');
const User = require('../models/userModel');
const mongoose = require('mongoose');

// Get all chats for a user
exports.getChats = async (req, res) => {
  try {
    const chats = await Chat.find({
      participants: req.user._id,
      isActive: true
    })
    .populate({
      path: 'participants',
      select: 'firstName lastName username profileCreatedAt interests gender location'
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

// Get single chat by ID
exports.getChatById = async (req, res) => {
  try {
    const chat = await Chat.findOne({
      _id: req.params.chatId,
      participants: req.user._id,
      isActive: true
    })
    .populate({
      path: 'participants',
      select: 'firstName lastName username profileCreatedAt interests gender location'
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

// Get messages for a chat
exports.getChatMessages = async (req, res) => {
  try {
    // Check if chat exists and user is a participant
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

    // Get messages
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

// End current random chat
exports.endRandomChat = async (req, res) => {
  try {
    const { chatId } = req.params;

    // Check if chat exists and user is a participant
    const chat = await Chat.findOne({
      _id: chatId,
      participants: req.user._id,
      isActive: true
    });

    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found'
      });
    }

    // Mark chat as inactive
    chat.isActive = false;
    await chat.save();

    res.status(200).json({
      success: true,
      message: 'Chat ended successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Find a random user to chat with based on mutual interests
exports.findRandomMatch = async (req, res) => {
  try {
    const userId = req.user._id;
    const chatPreference = req.user.chatPreference;
    const userInterests = req.user.interests;

    // Find users who:
    // 1. Are not the current user
    // 2. Are online
    // 3. Have at least one matching interest
    // 4. Have the same chat preference
    // 5. Are not already in an active chat with the current user
    
    // First, find active chats this user is in
    const activeChats = await Chat.find({
      participants: userId,
      isActive: true
    });
    
    // Get IDs of users already chatting with this user
    const activeParticipantIds = [];
    activeChats.forEach(chat => {
      chat.participants.forEach(participantId => {
        if (!participantId.equals(userId)) {
          activeParticipantIds.push(participantId);
        }
      });
    });
    
    // Find potential matches
    const potentialMatches = await User.aggregate([
      // Exclude current user and users already chatting with
      {
        $match: {
          _id: { 
            $ne: mongoose.Types.ObjectId(userId),
            $nin: activeParticipantIds.map(id => mongoose.Types.ObjectId(id))
          },
          online: true,
          chatPreference: chatPreference
        }
      },
      // Add field with count of matching interests
      {
        $addFields: {
          matchingInterestsCount: {
            $size: {
              $setIntersection: ["$interests", userInterests]
            }
          }
        }
      },
      // Only include users with at least one matching interest
      {
        $match: {
          matchingInterestsCount: { $gt: 0 }
        }
      },
      // Sort by number of matching interests (descending)
      {
        $sort: {
          matchingInterestsCount: -1,
          lastActive: -1
        }
      },
      // Limit to one random match
      {
        $limit: 1
      }
    ]);

    if (potentialMatches.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No matching users found at the moment. Try again later.'
      });
    }

    const matchedUser = potentialMatches[0];

    // Create a new chat
    const newChat = await Chat.create({
      participants: [userId, matchedUser._id],
      chatType: chatPreference,
      isActive: true
    });

    // Populate participant details
    const populatedChat = await Chat.findById(newChat._id)
      .populate({
        path: 'participants',
        select: 'firstName lastName username profileCreatedAt interests gender location'
      });

    res.status(200).json({
      success: true,
      message: 'Match found!',
      data: populatedChat
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};