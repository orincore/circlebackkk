const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const { connectDB } = require('./config/db');
const User = require('./models/userModel');
const Chat = require('./models/chatModel');
const Message = require('./models/messageModel'); // Ensure this model exists

dotenv.config();

// Initialize application
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }
});

app.set('io', io);

// Database connection
connectDB();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// State management
const activeUsers = new Map();
const matchIntervals = new Map();
const pendingMatches = new Map();

// ==================== WebSocket Handlers ====================
io.on('connection', (socket) => {
  console.log(`\n[CONNECTION] New connection: ${socket.id}`);

  // Add chat room joining handler
  socket.on('join-chat', (chatId) => {
    console.log(`[SOCKET JOIN] ${socket.id} joining chat ${chatId}`);
    socket.join(chatId);
  });

  // Authentication handler
  socket.on('authenticate', async (userId) => {
    try {
      console.log(`[AUTH ATTEMPT] For user: ${userId}`);
      const user = await User.findById(userId);
      if (!user) {
        console.log(`[AUTH FAILED] User not found: ${userId}`);
        socket.emit('auth-error', 'User not found');
        return;
      }

      const currentStatus = activeUsers.get(userId)?.status || 'online';
      const userData = {
        socketId: socket.id,
        interests: user.interests.map(i => i.toLowerCase().trim()),
        chatPreference: user.chatPreference,
        status: currentStatus,
      };

      activeUsers.set(userId, userData);
      console.log(`[AUTH SUCCESS] User ${userId} authenticated`);

      await User.findByIdAndUpdate(userId, {
        online: true,
        chatStatus: currentStatus,
        lastActive: new Date()
      });

    } catch (error) {
      console.error('[AUTH ERROR]', error);
      socket.emit('auth-error', 'Authentication failed');
    }
  });

  // Matchmaking handlers
  socket.on('start-search', async (userId) => {
    try {
      console.log(`[SEARCH START] Initiated by: ${userId}`);
      const user = await User.findById(userId);
      if (!user) {
        console.log(`[SEARCH BLOCKED] User not found: ${userId}`);
        return;
      }
      if (user.chatStatus === 'in_chat') {
        console.log(`[SEARCH BLOCKED] User ${userId} already in chat`);
        socket.emit('search-error', 'Already in a chat');
        return;
      }

      // Update user status
      activeUsers.set(userId, {
        ...activeUsers.get(userId),
        status: 'searching'
      });

      // Clear existing interval
      if (matchIntervals.has(userId)) {
        console.log(`[SEARCH CLEAR] Existing interval for: ${userId}`);
        clearInterval(matchIntervals.get(userId));
      }

      // Start new matchmaking interval
      const interval = setInterval(async () => {
        try {
          console.log(`[MATCHMAKING] Checking matches for ${userId}`);
          const match = await findMatch(userId);
          if (match) {
            console.log(`[MATCH FOUND] For ${userId}: ${match.userId}`);
            clearInterval(interval);
            handlePotentialMatch(userId, match);
          }
        } catch (error) {
          console.error('[MATCHMAKING ERROR]', error);
          socket.emit('matchmaking-error', 'Matchmaking failed');
        }
      }, 3000);

      matchIntervals.set(userId, interval);
      console.log(`[SEARCH STARTED] For user ${userId}`);

    } catch (error) {
      console.error('[SEARCH ERROR]', error);
      socket.emit('search-error', 'Search initialization failed');
    }
  });

  // Match response handlers
  socket.on('accept-match', async ({ chatId, userId }) => {
    console.log(`[ACCEPT MATCH] ${userId} for chat ${chatId}`);
    try {
      const result = await handleMatchResponse(io, chatId, userId, true);
      handleMatchResult(result, chatId);
    } catch (error) {
      console.error('[ACCEPT ERROR]', error);
      socket.emit('match-error', 'Failed to accept match');
    }
  });

  socket.on('reject-match', async ({ chatId, userId }) => {
    console.log(`[REJECT MATCH] ${userId} for chat ${chatId}`);
    try {
      const result = await handleMatchResponse(io, chatId, userId, false);
      handleMatchResult(result, chatId);
    } catch (error) {
      console.error('[REJECT ERROR]', error);
      socket.emit('match-error', 'Failed to reject match');
    }
  });

  // Message handler - fixed version
  socket.on('send-message', async ({ chatId, senderId, content }) => {
    try {
      console.log(`[MESSAGE] Received in ${chatId} from ${senderId}`);
      
      // Validate input
      if (!content || !chatId || !senderId) {
        throw new Error('Missing message parameters');
      }

      // Create message in database
      const message = await Message.create({
        content,
        sender: senderId,
        chat: chatId
      });

      // Populate sender information
      const populatedMessage = await Message.populate(message, {
        path: 'sender',
        select: 'username avatar'
      });

      // Verify chat exists
      const chat = await Chat.findById(chatId);
      if (!chat) {
        throw new Error('Chat not found');
      }

      // Send message to room
      console.log(`[MESSAGE BROADCAST] To chat ${chatId}`);
      io.to(chatId).emit('new-message', populatedMessage);

    } catch (error) {
      console.error('[MESSAGE ERROR]', error);
      socket.emit('message-error', error.message);
    }
  });

  // Disconnect handler
  socket.on('disconnect', async () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    for (const [userId, data] of activeUsers.entries()) {
      if (data.socketId === socket.id) {
        cleanupUser(userId);
        await User.findByIdAndUpdate(userId, {
          online: false,
          chatStatus: 'offline'
        });
        break;
      }
    }
  });
});

// ==================== Matchmaking Logic ====================
const findMatch = async (userId) => {
  try {
    console.log(`[FIND MATCH] Starting search for: ${userId}`);
    const searcher = activeUsers.get(userId);
    if (!searcher || searcher.status !== 'searching') {
      console.log(`[FIND MATCH ABORT] User ${userId} not searching`);
      return null;
    }

    const potentialMatches = [];
    const searcherPref = searcher.chatPreference?.toLowerCase();
    
    console.log(`[MATCH PARAMS] Searcher pref: ${searcherPref}`);

    activeUsers.forEach((candidate, candidateId) => {
      if (candidateId === userId.toString()) {
        console.log(`[MATCH SKIP] Same user: ${candidateId}`);
        return;
      }
      if (candidate.status !== 'searching') {
        console.log(`[MATCH SKIP] User ${candidateId} not searching`);
        return;
      }

      const candidatePref = candidate.chatPreference?.toLowerCase();
      if (candidatePref !== searcherPref) {
        console.log(`[MATCH SKIP] Pref mismatch: ${candidatePref} vs ${searcherPref}`);
        return;
      }

      const commonInterests = candidate.interests.filter(interest =>
        searcher.interests.includes(interest)
      );

      if (commonInterests.length > 0) {
        console.log(`[MATCH CANDIDATE] Found: ${candidateId} with ${commonInterests.length} common interests`);
        potentialMatches.push({
          userId: candidateId,
          socketId: candidate.socketId,
          commonCount: commonInterests.length
        });
      }
    });

    if (potentialMatches.length > 0) {
      const bestMatch = potentialMatches.sort((a, b) => b.commonCount - a.commonCount)[0];
      console.log(`[MATCH SELECTED] Best match: ${bestMatch.userId}`);
      return bestMatch;
    }
    
    console.log(`[NO MATCHES] For user: ${userId}`);
    return null;
  } catch (error) {
    console.error('[FIND MATCH ERROR]', error);
    throw error;
  }
};

const handlePotentialMatch = async (searcherId, match) => {
  try {
    console.log(`[HANDLE POTENTIAL MATCH] Between ${searcherId} and ${match.userId}`);
    const chatId = new mongoose.Types.ObjectId().toString();
    
    pendingMatches.set(chatId, {
      users: [searcherId, match.userId],
      chatId,
      acceptances: [],
      rejections: [],
      expiresAt: Date.now() + 120000
    });

    console.log(`[PENDING MATCH CREATED] Chat ID: ${chatId}`);

    setTimeout(() => {
      if (pendingMatches.has(chatId)) {
        console.log(`[MATCH EXPIRED] ${chatId}`);
        pendingMatches.delete(chatId);
      }
    }, 120000);

    activeUsers.set(searcherId, { ...activeUsers.get(searcherId), status: 'pending' });
    activeUsers.set(match.userId, { ...activeUsers.get(match.userId), status: 'pending' });

    const [user1, user2] = await Promise.all([
      User.findById(searcherId),
      User.findById(match.userId)
    ]);

    console.log(`[NOTIFYING USERS] About match ${chatId}`);
    
    io.to(match.socketId).emit('match-found', {
      chatId,
      user: user1.toObject(),
      promptUser: true
    });

    io.to(activeUsers.get(searcherId).socketId).emit('match-found', {
      chatId,
      user: user2.toObject(),
      promptUser: false
    });

  } catch (error) {
    console.error('[MATCH HANDLING ERROR]', error);
    throw error;
  }
};

// ==================== Utility Functions ====================
const handleMatchResponse = async (io, chatId, userId, isAccept) => {
  try {
    console.log(`[HANDLE MATCH RESPONSE] Chat: ${chatId}, User: ${userId}, Accept: ${isAccept}`);
    const match = pendingMatches.get(chatId);
    if (!match) {
      console.log(`[MATCH EXPIRED] Chat ID: ${chatId}`);
      throw new Error('Match expired');
    }

    const responseArray = isAccept ? match.acceptances : match.rejections;
    responseArray.push(userId);
    console.log(`[RESPONSE UPDATED] Chat ${chatId}: Accepts ${match.acceptances.length}, Rejects ${match.rejections.length}`);

    if (match.acceptances.length + match.rejections.length === 2) {
      let result;
      
      if (match.acceptances.length === 2) {
        console.log(`[MATCH ACCEPTED] By both users for chat ${chatId}`);
        const [user1, user2] = await Promise.all([
          User.findById(match.users[0]),
          User.findById(match.users[1])
        ]);

        if (!user1 || !user2) {
          console.log(`[USER MISSING] User1: ${match.users[0]}, User2: ${match.users[1]}`);
          throw new Error('One or both users not found');
        }

        const pref1 = user1.chatPreference?.toLowerCase();
        const pref2 = user2.chatPreference?.toLowerCase();
        console.log(`[PREF CHECK] ${pref1} vs ${pref2}`);

        if (pref1 !== pref2) {
          console.log(`[PREF MISMATCH] ${pref1} != ${pref2}`);
          throw new Error('Mismatched chat preferences');
        }

        const chatType = user1.chatPreference.charAt(0).toUpperCase() + 
                        user1.chatPreference.slice(1).toLowerCase();
        console.log(`[CHAT CREATION] Type: ${chatType}`);

        const chat = await Chat.create({
          participants: match.users.map(id => new mongoose.Types.ObjectId(id)),
          chatType: chatType,
          isActive: true
        }).catch(error => {
          console.error('[CHAT CREATION ERROR]', error);
          throw new Error('Failed to create chat');
        });

        if (!chat) {
          console.log(`[CHAT CREATION FAILED] For ${chatId}`);
          throw new Error('Chat creation failed');
        }

        console.log(`[CHAT CREATED] ID: ${chat._id}`);
        
        await User.updateMany(
          { _id: { $in: match.users } },
          { 
            chatStatus: 'in_chat',
            $addToSet: { activeChats: chat._id }
          }
        );

        match.users.forEach(userId => {
          const entry = activeUsers.get(userId);
          if (entry) {
            entry.status = 'in_chat';
            console.log(`[USER STATUS UPDATE] ${userId} to in_chat`);
          }
        });

        result = { success: true, chat };
      } else {
        console.log(`[MATCH REJECTED] For chat ${chatId}`);
        await User.updateMany(
          { _id: { $in: match.users } },
          { chatStatus: 'online' }
        );
        result = { success: false, status: 'rejected' };
      }

      pendingMatches.delete(chatId);
      return result;
    }
    return { success: true, status: 'pending' };
  } catch (error) {
    console.error('[MATCH RESPONSE ERROR]', error);
    throw error;
  }
};

const handleMatchResult = (result, chatId) => {
  try {
    console.log(`[HANDLE MATCH RESULT] For chat ${chatId}, Success: ${result.success}`);
    if (result.success && result.chat) {
      console.log(`[MATCH CONFIRMED] Chat ${chatId}`);
      
      // Notify both users to join the chat room
      result.chat.participants.forEach(userId => {
        const userData = activeUsers.get(userId);
        if (userData) {
          io.to(userData.socketId).emit('join-chat-room', chatId);
        }
      });

      io.to(chatId).emit('match-confirmed', {
        chatId,
        participants: result.chat.participants
      });
    } else if (result.success) {
      console.error(`[MATCH ERROR] Chat creation failed for ${chatId}`);
      io.to(chatId).emit('match-error', { 
        message: 'Failed to create chat session' 
      });
    } else {
      console.log(`[MATCH REJECTED] Notifying chat ${chatId}`);
      io.to(chatId).emit('match-rejected', { chatId });
    }
  } catch (error) {
    console.error('[MATCH RESULT HANDLING ERROR]', error);
  }
};

const cleanupUser = (userId) => {
  console.log(`[CLEANUP START] For user ${userId}`);
  const interval = matchIntervals.get(userId);
  if (interval) {
    console.log(`[CLEAR INTERVAL] For user ${userId}`);
    clearInterval(interval);
  }
  
  matchIntervals.delete(userId);
  activeUsers.delete(userId);
  console.log(`[CLEANUP COMPLETE] For ${userId}`);
};

// ==================== Route Integration ====================
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/chat', require('./routes/chatRoutes'));
app.use('/api/post', require('./routes/postRoutes'));

app.get('/', (req, res) => res.send('Chat Service API'));

// Start server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`\n[SERVER] Running on port ${PORT}`);
});
