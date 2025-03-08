const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const { connectDB } = require('./config/db');
const User = require('./models/userModel');
const Chat = require('./models/chatModel');

dotenv.config();

// Initialize application
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

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

  // Authentication handler
  socket.on('authenticate', async (userId) => {
    try {
      const user = await User.findById(userId);
      if (!user) {
        console.log(`[AUTH FAILED] User not found: ${userId}`);
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
    }
  });

  // Matchmaking handlers
  socket.on('start-search', async (userId) => {
    try {
      const user = await User.findById(userId);
      if (!user || user.chatStatus === 'in_chat') {
        console.log(`[SEARCH BLOCKED] User ${userId} in chat`);
        return;
      }

      // Update user status
      activeUsers.set(userId, {
        ...activeUsers.get(userId),
        status: 'searching'
      });

      // Clear existing interval
      if (matchIntervals.has(userId)) {
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
        }
      }, 3000);

      matchIntervals.set(userId, interval);
      console.log(`[SEARCH STARTED] For user ${userId}`);
    } catch (error) {
      console.error('[SEARCH ERROR]', error);
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
    }
  });

  socket.on('reject-match', async ({ chatId, userId }) => {
    console.log(`[REJECT MATCH] ${userId} for chat ${chatId}`);
    try {
      const result = await handleMatchResponse(io, chatId, userId, false);
      handleMatchResult(result, chatId);
    } catch (error) {
      console.error('[REJECT ERROR]', error);
    }
  });

  // Message handler
  socket.on('send-message', async ({ chatId, senderId, content }) => {
    try {
      console.log(`[MESSAGE] Received in ${chatId} from ${senderId}`);
      const result = await handleMessage(io, { chatId, senderId, content });
      if (result.success) {
        io.to(chatId).emit('new-message', result.message);
      }
    } catch (error) {
      console.error('[MESSAGE ERROR]', error);
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
    const searcher = activeUsers.get(userId);
    if (!searcher || searcher.status !== 'searching') return null;

    const potentialMatches = [];
    
    activeUsers.forEach((candidate, candidateId) => {
      if (candidateId === userId.toString()) return;
      if (candidate.status !== 'searching') return;
      if (candidate.chatPreference !== searcher.chatPreference) return;

      const commonInterests = candidate.interests.filter(interest =>
        searcher.interests.includes(interest)
      );

      if (commonInterests.length > 0) {
        potentialMatches.push({
          userId: candidateId,
          socketId: candidate.socketId,
          commonCount: commonInterests.length
        });
      }
    });

    if (potentialMatches.length > 0) {
      return potentialMatches.sort((a, b) => b.commonCount - a.commonCount)[0];
    }
    return null;
  } catch (error) {
    console.error('[FIND MATCH ERROR]', error);
    return null;
  }
};

const handlePotentialMatch = async (searcherId, match) => {
  try {
    // Create pending match
    const chatId = new mongoose.Types.ObjectId().toString();
    pendingMatches.set(chatId, {
      users: [searcherId, match.userId],
      chatId,
      acceptances: [],
      rejections: [],
      expiresAt: Date.now() + 120000
    });

    // Set expiration timer
    setTimeout(() => {
      if (pendingMatches.has(chatId)) {
        pendingMatches.delete(chatId);
        console.log(`[MATCH EXPIRED] ${chatId}`);
      }
    }, 120000);

    // Update user statuses
    activeUsers.set(searcherId, { ...activeUsers.get(searcherId), status: 'pending' });
    activeUsers.set(match.userId, { ...activeUsers.get(match.userId), status: 'pending' });

    // Notify users
    const [user1, user2] = await Promise.all([
      User.findById(searcherId),
      User.findById(match.userId)
    ]);

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
  }
};

// ==================== Utility Functions ====================
const handleMatchResponse = async (io, chatId, userId, isAccept) => {
  try {
    const match = pendingMatches.get(chatId);
    if (!match) throw new Error('Match expired');

    const responseArray = isAccept ? match.acceptances : match.rejections;
    responseArray.push(userId);

    if (match.acceptances.length + match.rejections.length === 2) {
      let result;
      
      if (match.acceptances.length === 2) {
        // Get both users' data
        const [user1, user2] = await Promise.all([
          User.findById(match.users[0]),
          User.findById(match.users[1])
        ]);

        // Verify matching preferences
        if (user1.chatPreference !== user2.chatPreference) {
          throw new Error('Mismatched chat preferences');
        }

        // Create chat with correct type
        const chat = await Chat.create({
          participants: match.users,
          chatType: user1.chatPreference, // Use the common preference
          isActive: true
        }).catch(error => {
          console.error('[CHAT CREATION ERROR]', error);
          throw new Error('Failed to create chat');
        });

        if (!chat) {
          throw new Error('Chat creation failed');
        }

        // Update users
        await User.updateMany(
          { _id: { $in: match.users } },
          { 
            chatStatus: 'in_chat',
            $addToSet: { activeChats: chat._id }
          }
        );

        // Update activeUsers status
        match.users.forEach(userId => {
          const entry = activeUsers.get(userId);
          if (entry) entry.status = 'in_chat';
        });

        result = { success: true, chat };
      } else {
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
  if (result.success && result.chat) { // Add null check for result.chat
    io.to(chatId).emit('match-confirmed', {
      chatId,
      participants: result.chat.participants
    });
  } else if (result.success) {
    console.error('[MATCH ERROR] Chat creation failed for', chatId);
    io.to(chatId).emit('match-error', { 
      message: 'Failed to create chat session' 
    });
  } else {
    io.to(chatId).emit('match-rejected', { chatId });
  }
};

const cleanupUser = (userId) => {
  const interval = matchIntervals.get(userId);
  if (interval) clearInterval(interval);
  
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
