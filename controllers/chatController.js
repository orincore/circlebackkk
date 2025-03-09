const mongoose = require('mongoose');
const Chat = require('../models/chatModel');
const Message = require('../models/messageModel');
const User = require('../models/userModel');
const Block = require('../models/blockModel');

// Shared state management
const pendingMatches = new Map();
const activeUsers = new Map();

// ==================== Match Management ====================
const createChatSession = async (io, creatorId, participantId, chatType = 'Friendship') => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate inputs
    if (!mongoose.Types.ObjectId.isValid(creatorId) || 
        !mongoose.Types.ObjectId.isValid(participantId)) {
      throw new Error('Invalid user ID format');
    }

    // Check for existing chat
    const existingChat = await Chat.findOne({
      participants: { $all: [creatorId, participantId] },
      chatType
    }).populate('participants', 'firstName lastName username avatar');

    if (existingChat) {
      return { 
        success: true, 
        data: existingChat,
        message: 'Existing chat found'
      };
    }

    // Create new chat with population
    const newChat = await Chat.create({
      participants: [creatorId, participantId],
      chatType,
      isActive: true
    });

    const populatedChat = await Chat.populate(newChat, {
      path: 'participants',
      select: 'firstName lastName username avatar'
    });

    // Update users
    await User.updateMany(
      { _id: { $in: [creatorId, participantId] } },
      { 
        $addToSet: { activeChats: populatedChat._id },
        chatStatus: 'in_chat'
      }
    );

    // Commit transaction
    await session.commitTransaction();

    return {
      success: true,
      data: populatedChat,
      message: 'New chat created successfully'
    };

  } catch (error) {
    await session.abortTransaction();
    return { 
      success: false, 
      error: error.message 
    };
  } finally {
    session.endSession();
  }
};

const handleMatchResponse = async (io, chatId, userId, isAccept) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const match = pendingMatches.get(chatId);
    if (!match) throw new Error('Match expired');

    const userIdStr = userId.toString();
    const responseArray = isAccept ? match.acceptances : match.rejections;
    
    if ([...match.acceptances, ...match.rejections].includes(userIdStr)) {
      await session.abortTransaction();
      return { success: true, status: 'pending' };
    }

    responseArray.push(userIdStr);
    pendingMatches.set(chatId, match);

    // Handle final decision
    if (match.acceptances.length + match.rejections.length === 2) {
      let result;
      
      if (match.acceptances.length === 2) {
        const chat = await Chat.create([{
          participants: match.users,
          chatType: match.chatType,
          isActive: true
        }], { session });

        await User.updateMany(
          { _id: { $in: match.users } },
          { 
            chatStatus: 'in_chat',
            online: true,
            $addToSet: { activeChats: chat[0]._id }
          },
          { session }
        );

        const [user1, user2] = await User.find({ 
          _id: { $in: match.users } 
        }).session(session);

        // Emit to both users
        emitMatchConfirmation(io, match.users, user1, user2, chat[0]._id);
        
        result = { success: true, chat: chat[0] };
      } else {
        await User.updateMany(
          { _id: { $in: match.users } },
          { chatStatus: 'online' },
          { session }
        );
        result = { success: false, status: 'rejected' };
      }

      pendingMatches.delete(chatId);
      await session.commitTransaction();
      return result;
    }

    await session.commitTransaction();
    return { success: true, status: 'pending' };
  } catch (error) {
    await session.abortTransaction();
    return { success: false, error: error.message };
  } finally {
    session.endSession();
  }
};

// ==================== Message Handling ====================
const handleMessage = async (io, { chatId, senderId, content }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate inputs
    if (!mongoose.Types.ObjectId.isValid(chatId) || 
        !mongoose.Types.ObjectId.isValid(senderId)) {
      throw new Error('Invalid ID format');
    }

    // Create and populate message
    const message = await Message.create({
      chat: chatId,
      sender: senderId,
      content
    });

    const populatedMessage = await Message.populate(message, {
      path: 'sender',
      select: 'firstName lastName username avatar'
    });

    // Update chat
    await Chat.findByIdAndUpdate(
      chatId,
      {
        lastMessage: populatedMessage._id,
        $inc: { unreadCount: 1 },
        updatedAt: new Date()
      }
    );

    // Emit message
    io.to(chatId.toString()).emit('new-message', populatedMessage);

    await session.commitTransaction();
    return {
      success: true,
      data: populatedMessage,
      message: 'Message sent successfully'
    };

  } catch (error) {
    await session.abortTransaction();
    return { 
      success: false, 
      error: error.message 
    };
  } finally {
    session.endSession();
  }
};


// ==================== Core Chat Functions ====================
const getChats = async (req, res) => {
  try {
    const chats = await Chat.find({
      participants: req.user._id,
      isActive: true
    })
    .populate({
      path: 'participants',
      select: 'firstName lastName username avatar online'
    })
    .populate({
      path: 'lastMessage',
      select: 'content sender createdAt'
    })
    .sort('-updatedAt');

    res.status(200).json({ success: true, data: chats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getMessageHistory = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (page - 1) * limit;

    const messages = await Message.find({ chat: req.params.chatId })
      .populate('sender', 'username avatar')
      .sort('-createdAt')
      .skip(skip)
      .limit(limit);

    res.status(200).json({ success: true, data: messages });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==================== Helper Functions ====================
const emitMatchConfirmation = (io, userIds, user1, user2, chatId) => {
  const [id1, id2] = userIds.map(id => id.toString());
  const socket1 = activeUsers.get(id1)?.socketId;
  const socket2 = activeUsers.get(id2)?.socketId;

  const payload = {
    chatId,
    participants: [user1, user2],
    partner: null
  };

  if (socket1) {
    io.to(socket1).emit('match-confirmed', { 
      ...payload,
      partner: user2 
    });
  }
  
  if (socket2) {
    io.to(socket2).emit('match-confirmed', { 
      ...payload,
      partner: user1 
    });
  }
};

// ==================== Export Controller ====================
module.exports = {
  // Match handling
  initiateMatchmaking: async (userId) => {
    try {
      const user = await User.findByIdAndUpdate(
        userId,
        { chatStatus: 'searching', lastActive: new Date() },
        { new: true }
      );
      return { success: true, user };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  handleMatchAcceptance: (io, chatId, userId) => 
    handleMatchResponse(io, chatId, userId, true),
  
  handleMatchRejection: (io, chatId, userId) => 
    handleMatchResponse(io, chatId, userId, false),

  // Message handling
  handleMessage: (io, data) => handleMessage(io, data),
  
  // Chat operations
  getChats,
  getChatById: async (req, res) => {
    try {
      const chat = await Chat.findOne({
        _id: req.params.chatId,
        participants: req.user._id
      }).populate('participants', 'username avatar online');
      
      chat ? res.status(200).json({ success: true, data: chat })
           : res.status(404).json({ success: false, error: 'Chat not found' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  endRandomChat: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const chat = await Chat.findOneAndUpdate(
        { _id: req.params.chatId, participants: req.user._id },
        { isActive: false },
        { session, new: true }
      );
      
      if (!chat) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, error: 'Chat not found' });
      }

      await User.updateMany(
        { _id: { $in: chat.participants } },
        { $pull: { activeChats: chat._id }, chatStatus: 'online' },
        { session }
      );

      await session.commitTransaction();
      res.status(200).json({ success: true, data: chat });
    } catch (error) {
      await session.abortTransaction();
      res.status(500).json({ success: false, error: error.message });
    } finally {
      session.endSession();
    }
  },

  // Additional features
  searchMessages: async (req, res) => {
    try {
      const results = await Message.find({
        chat: req.params.chatId,
        content: { $regex: req.query.q, $options: 'i' }
      }).populate('sender', 'username');
      
      res.status(200).json({ success: true, data: results });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  handleTypingIndicator: (io, chatId, userId) => {
    io.to(chatId).emit('typing-indicator', { userId });
  },

  handleBlockUser: (req, res) => {
        // Simple block user implementation
        Block.create({
          blocker: req.user._id,
          blocked: req.params.userId
        })
          .then(() => res.status(200).json({ success: true, message: 'User blocked' }))
          .catch((error) => res.status(500).json({ success: false, message: error.message }));
      },
      getMessageHistory: async (req, res) => {
        try {
          const { page = 1, limit = 50 } = req.query;
          const skip = (page - 1) * limit;
      
          const messages = await Message.find({ chat: req.params.chatId })
            .populate('sender', 'username avatar')
            .sort('-createdAt')
            .skip(skip)
            .limit(limit);
      
          res.status(200).json({
            success: true,
            count: messages.length,
            page: Number(page),
            data: messages
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: error.message
          });
        }
      },

// ==================== CHAT SESSION MANAGEMENT ====================
createChatSession: async (io, user1Id, user2Id, chatType) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Check for existing chat
    const existingChat = await Chat.findOne({
      participants: { $all: [user1Id, user2Id] },
      chatType
    }).session(session);

    if (existingChat) {
      await session.abortTransaction();
      return { success: true, chat: existingChat };
    }

    // Create new chat
    const newChat = await Chat.create([{
      participants: [user1Id, user2Id],
      chatType,
      isActive: true
    }], { session });

    await session.commitTransaction();
    return { success: true, chat: newChat[0] };
    
  } catch (error) {
    await session.abortTransaction();
    return { success: false, error: error.message };
  } finally {
    session.endSession();
  }
},

// ==================== MESSAGE MANAGEMENT ====================
editMessage: async (req, res) => {
  try {
    const message = await Message.findOneAndUpdate(
      { 
        _id: req.params.messageId,
        sender: req.user._id 
      },
      { 
        content: req.body.content,
        edited: true,
        editedAt: new Date()
      },
      { new: true }
    ).populate('sender', 'username avatar');

    if (!message) {
      return res.status(404).json({ 
        success: false, 
        message: 'Message not found or unauthorized' 
      });
    }

    res.status(200).json({ success: true, data: message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
},

deleteMessage: async (req, res) => {
  try {
    const message = await Message.findOneAndDelete({
      _id: req.params.messageId,
      sender: req.user._id
    });

    if (!message) {
      return res.status(404).json({ 
        success: false, 
        message: 'Message not found or unauthorized' 
      });
    }

    res.status(200).json({ 
      success: true, 
      message: 'Message deleted successfully' 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
},

// ==================== CHAT ACTIONS ====================
archiveChat: async (req, res) => {
  try {
    const chat = await Chat.findOneAndUpdate(
      { 
        _id: req.params.chatId,
        participants: req.user._id 
      },
      { isArchived: true },
      { new: true }
    ).populate('participants', 'username avatar');

    if (!chat) {
      return res.status(404).json({ 
        success: false, 
        message: 'Chat not found' 
      });
    }

    res.status(200).json({ success: true, data: chat });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
},

// ==================== REACTIONS ====================
addReaction: async (req, res) => {
  try {
    const message = await Message.findByIdAndUpdate(
      req.params.messageId,
      {
        $push: {
          reactions: {
            emoji: req.body.emoji,
            user: req.user._id
          }
        }
      },
      { new: true }
    ).populate('reactions.user', 'username');

    if (!message) {
      return res.status(404).json({ 
        success: false, 
        message: 'Message not found' 
      });
    }

    res.status(200).json({ success: true, data: message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
},

handleReadAll: async (io, { chatId, userId }) => {
  try {
    // Find messages in the chat that were not sent by the current user and not yet marked as read
    const messages = await Message.find({
      chat: chatId,
      sender: { $ne: userId },
      read: { $ne: true }
    });
    const messageIds = messages.map(msg => msg._id.toString());

    // Mark those messages as read
    await Message.updateMany(
      { chat: chatId, sender: { $ne: userId }, read: { $ne: true } },
      { $set: { read: true } }
    );

    // Emit an event so that clients in the chat room update read receipts
    io.to(chatId.toString()).emit("read-all", { chatId, messageIds });
    return { success: true, message: "Messages marked as read" };
  } catch (error) {
    return { success: false, error: error.message };
  }
},

// Emit a "stop-typing" event so that clients know the user has stopped typing
stopTypingIndicator: (io, chatId, userId) => {
  try {
    io.to(chatId.toString()).emit("stop-typing", { chatId, userId });
    return { success: true, message: "Typing indicator stopped" };
  } catch (error) {
    return { success: false, error: error.message };
  }
},

// Unarchive a chat: set its archived flag to false
unarchiveChat: async (req, res) => {
  try {
    const chat = await Chat.findOneAndUpdate(
      { _id: req.params.chatId, participants: req.user._id },
      { isArchived: false },
      { new: true }
    ).populate('participants', 'username avatar');
    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    res.status(200).json({ success: true, data: chat, message: "Chat unarchived" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
},

// Unblock a user: remove the block record for the current user blocking another user
unblockUser: async (req, res) => {
  try {
    const { userId: unblockUserId } = req.params;
    // Remove the block record from the Block model (assumes Block model exists)
    const result = await Block.findOneAndDelete({
      blocker: req.user._id,
      blocked: unblockUserId
    });
    if (!result) {
      return res.status(404).json({ success: false, message: 'Block record not found' });
    }
    res.status(200).json({ success: true, message: "User unblocked successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}
};
// Mark all unread messages in a chat (sent by the partner) as read and emit a read receipt event
