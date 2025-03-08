const Chat = require('../models/chatModel');
const Message = require('../models/messageModel');
const User = require('../models/userModel');
const Block = require('../models/blockModel');
const mongoose = require('mongoose');

// Shared state management
const pendingMatches = new Map();
const activeUsers = new Map();

// ==================== Match Management ====================
const createChatSession = async (user1Id, user2Id, chatType) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const existing = Array.from(pendingMatches.values()).find(match => 
      match.users.some(u => u.equals(user1Id)) && 
      match.users.some(u => u.equals(user2Id))
    );
    
    if (existing) {
      await session.abortTransaction();
      return { success: true, chatId: existing.chatId };
    }

    const chatId = new mongoose.Types.ObjectId();
    const expiresAt = Date.now() + 120000;
    
    pendingMatches.set(chatId.toString(), {
      users: [user1Id, user2Id],
      chatId,
      acceptances: [],
      rejections: [],
      expiresAt,
      chatType
    });

    setTimeout(() => pendingMatches.delete(chatId.toString()), 120000);
    
    await session.commitTransaction();
    return { success: true, chatId: chatId.toString() };
  } catch (error) {
    await session.abortTransaction();
    return { success: false, error: error.message };
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
    const chat = await Chat.findById(chatId).session(session);
    if (!chat?.isActive) throw new Error('Chat is not active');

    const [message] = await Message.create([{
      chat: chatId,
      sender: senderId,
      content,
      readBy: [senderId]
    }], { session });

    const receiverId = chat.participants.find(id => !id.equals(senderId));
    
    await Chat.findByIdAndUpdate(
      chatId,
      {
        lastMessage: message._id,
        $inc: { unreadCount: 1 }
      },
      { session, new: true }
    );

    const populatedMessage = await Message.populate(message, {
      path: 'sender',
      select: 'firstName lastName username'
    });

    // Emit message to chat room
    io.to(chatId).emit('new-message', {
      chatId,
      message: populatedMessage
    });

    await session.commitTransaction();
    return {
      success: true,
      message: populatedMessage,
      receiverId
    };
  } catch (error) {
    await session.abortTransaction();
    return { success: false, error: error.message };
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
      }
};
