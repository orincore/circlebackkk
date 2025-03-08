const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const { connectDB } = require('./config/db');
const User = require('./models/userModel');
const Chat = require('./models/chatModel');
const { 
  handleMessage, 
  createChatSession, 
  handleMatchAcceptance, 
  handleMatchRejection 
} = require('./controllers/chatController');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// Configure Socket.IO
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Connect to MongoDB
connectDB();

// Active users map (userId -> userData)
const activeUsers = new Map();

// Matchmaking intervals map (userId -> interval)
const matchIntervals = new Map();

io.on('connection', (socket) => {
  console.log(`\n[CONNECTION] New connection: ${socket.id}`);

  // Authentication handler
  socket.on('authenticate', async ({ userId }) => {
    try {
      console.log(`\n[AUTH] Attempting authentication for: ${userId}`);
      const user = await User.findById(userId);
      if (!user) {
        console.log(`[AUTH FAILED] User not found: ${userId}`);
        return;
      }
      // Preserve existing status if present; default to 'online'
      const currentStatus = activeUsers.get(userId.toString())?.status || 'online';
      const userData = {
        socketId: socket.id,
        interests: user.interests.map(i => i.toLowerCase().trim()),
        chatPreference: user.chatPreference,
        status: currentStatus
      };
      activeUsers.set(userId.toString(), userData);
      console.log(`[AUTH SUCCESS] User ${userId} authenticated:`, {
        interests: userData.interests,
        chatPreference: userData.chatPreference,
        status: userData.status
      });
      await User.findByIdAndUpdate(userId, { 
        online: true,
        chatStatus: currentStatus,
        lastActive: new Date()
      });
    } catch (error) {
      console.error('[AUTH ERROR]', error);
    }
  });

  // Start matchmaking handler
  socket.on('start-search', async ({ userId }) => {
    try {
      console.log(`\n[SEARCH] Starting search for: ${userId}`);
      const user = await User.findById(userId);
      if (!user) {
        console.log(`[SEARCH FAILED] User not found: ${userId}`);
        return;
      }
      // Force fresh status update to 'searching'
      const userData = {
        socketId: socket.id,
        interests: user.interests.map(i => i.toLowerCase().trim()),
        chatPreference: user.chatPreference,
        status: 'searching'
      };
      activeUsers.set(userId.toString(), userData);
      console.log(`[SEARCH STATUS] User ${userId} now searching:`, userData);
      // Clear any existing matchmaking interval for the user
      if (matchIntervals.has(userId.toString())) {
        clearInterval(matchIntervals.get(userId.toString()));
      }
      // Create new matchmaking interval – run every 3 seconds
      const interval = setInterval(async () => {
        console.log(`\n[MATCHMAKING] Checking matches for ${userId}...`);
        try {
          const match = await findMatch(userId);
          if (match) {
            console.log(`[MATCH FOUND] For ${userId}:`, match.id);
            clearInterval(interval);
            matchIntervals.delete(userId.toString());
            handleMatchFound(userId, match);
          } else {
            console.log(`[NO MATCH] No matches found for ${userId} this cycle`);
          }
        } catch (error) {
          console.error('[MATCHMAKING ERROR]', error);
        }
      }, 3000);
      matchIntervals.set(userId.toString(), interval);
      console.log(`[INTERVAL SET] Matchmaking interval started for ${userId}`);
      // Cleanup on disconnect or end-search
      const cleanup = () => {
        console.log(`\n[CLEANUP] Initiating for ${userId}`);
        cleanupSearch(userId);
      };
      socket.once('disconnect', chanleanup);
      socket.once('end-search', cleanup);
    } catch (error) {
      console.error('[SEARCH ERROR]', error);
    }
  });

  // Accept match handler
  socket.on('accept-match', async ({ chatId, userId }) => {
    console.log(`\n[ACCEPT MATCH] User ${userId} accepted match for ${chatId}`);
    const result = await handleMatchAcceptance(chatId, userId);
    if (result.success && result.chat) {
      // Both accepted—notify both users
      const userAId = result.chat.participants[0].toString();
      const userBId = result.chat.participants[1].toString();
      const userAData = activeUsers.get(userAId);
      const userBData = activeUsers.get(userBId);
      if (userAData && userBData) {
        io.to(userAData.socketId).emit('match-confirmed', { chatId: result.chat._id });
        io.to(userBData.socketId).emit('match-confirmed', { chatId: result.chat._id });
        console.log(`[MATCH CONFIRMED] Chat ${result.chat._id} started for ${userAId} and ${userBId}`);
      }
    } else if (result.success && result.status === 'pending') {
      console.log(`[MATCH PENDING] Waiting for other user response for ${chatId}`);
    } else if (!result.success && result.status === 'rejected') {
      console.log(`[MATCH REJECTED] Chat ${chatId} rejected due to one user's response`);
      io.to(socket.id).emit('match-rejected', { chatId });
    }
  });

  // Reject match handler
  socket.on('reject-match', async ({ chatId, userId }) => {
    console.log(`\n[REJECT MATCH] User ${userId} rejected match for ${chatId}`);
    const result = await handleMatchRejection(chatId, userId);
    if (result.success && result.status === 'pending') {
      console.log(`[MATCH PENDING] Waiting for both responses for ${chatId}`);
    } else if (!result.success && result.status === 'rejected') {
      console.log(`[MATCH REJECTED] Chat ${chatId} rejected`);
      io.to(socket.id).emit('match-rejected', { chatId });
    }
  });

  // Message handler
  socket.on('send-message', async ({ chatId, senderId, content }) => {
    try {
      console.log(`\n[MESSAGE] Received from ${senderId} in ${chatId}`);
      const result = await handleMessage({ chatId, senderId, content });
      if (!result.success) {
        console.log(`[MESSAGE FAILED] Chat ${chatId}: ${result.error}`);
        return;
      }
      const receiverId = result.receiverId.toString();
      const receiverData = activeUsers.get(receiverId);
      if (receiverData) {
        console.log(`[MESSAGE ROUTED] To ${receiverId} (${receiverData.socketId})`);
        io.to(receiverData.socketId).emit('new-message', {
          chatId,
          message: result.message
        });
      } else {
        console.log(`[MESSAGE FAILED] Receiver ${receiverId} offline`);
      }
    } catch (error) {
      console.error('[MESSAGE ERROR]', error);
    }
  });

  // Disconnect handler
  socket.on('disconnect', async () => {
    console.log(`\n[DISCONNECT] Socket: ${socket.id}`);
    for (const [userId, data] of activeUsers.entries()) {
      if (data.socketId === socket.id) {
        console.log(`[USER DISCONNECT] Cleaning up ${userId}`);
        cleanupSearch(userId);
        await User.findByIdAndUpdate(userId, {
          online: false,
          chatStatus: 'offline',
          lastActive: new Date()
        });
        break;
      }
    }
  });
});

// --- Matchmaking algorithm ---
async function findMatch(userId) {
  try {
    console.log(`\n[FIND MATCH] Starting for ${userId}`);
    const searcher = activeUsers.get(userId.toString());
    if (!searcher) {
      console.log(`[MATCH FAIL] Searcher ${userId} not in active users`);
      return null;
    }
    if (searcher.status !== 'searching') {
      console.log(`[MATCH FAIL] Invalid status for ${userId}: ${searcher.status}`);
      return null;
    }
    console.log(`[MATCH PARAMS] For ${userId}:`, {
      interests: searcher.interests,
      preference: searcher.chatPreference,
      status: searcher.status
    });
    const potentialMatches = [];
    console.log(`[ACTIVE USERS] Total: ${activeUsers.size}`);
    for (const [id, candidate] of activeUsers.entries()) {
      if (id === userId.toString()) {
        console.log(`[CANDIDATE] Skipping self: ${id}`);
        continue;
      }
      console.log(`\n[CANDIDATE] Checking ${id}`, {
        status: candidate.status,
        preference: candidate.chatPreference,
        interests: candidate.interests
      });
      if (candidate.status !== 'searching') {
        console.log(`[CANDIDATE REJECTED] ${id} status: ${candidate.status}`);
        continue;
      }
      if (candidate.chatPreference !== searcher.chatPreference) {
        console.log(`[CANDIDATE REJECTED] Preference mismatch: ${candidate.chatPreference} vs ${searcher.chatPreference}`);
        continue;
      }
      // Calculate common interests count
      const commonInterests = candidate.interests.filter(interest =>
        searcher.interests.includes(interest)
      );
      console.log(`[INTEREST CHECK] Between ${userId} and ${id}`, {
        searcher: searcher.interests,
        candidate: candidate.interests,
        common: commonInterests
      });
      if (commonInterests.length > 0) {
        console.log(`[POTENTIAL MATCH] Found with ${id} (${commonInterests.length} common interests)`);
        potentialMatches.push({ id, ...candidate, commonCount: commonInterests.length });
      } else {
        console.log(`[NO COMMON INTERESTS] Between ${userId} and ${id}`);
      }
    }
    console.log(`[MATCH RESULTS] For ${userId}: ${potentialMatches.length} potential matches`);
    if (potentialMatches.length > 1) {
      potentialMatches.sort((a, b) => b.commonCount - a.commonCount);
    }
    return potentialMatches.length > 0 
      ? potentialMatches[0]  // Choose the best match candidate
      : null;
  } catch (error) {
    console.error('[MATCH ERROR]', error);
    return null;
  }
}

// --- Handle successful match ---
async function handleMatchFound(userId, match) {
  try {
    console.log(`\n[CHAT CREATION] Starting for ${userId} and ${match.id}`);
    // Destructure chatId from createChatSession instead of chat
    const { chatId } = await createChatSession(
      userId,
      match.id,
      activeUsers.get(userId).chatPreference
    );
    console.log(`[CHAT CREATED] ID: ${chatId}`);
    // Set both users to 'pending' until they respond
    activeUsers.set(userId.toString(), { ...activeUsers.get(userId), status: 'pending' });
    activeUsers.set(match.id, { ...match, status: 'pending' });
    console.log(`[STATUS UPDATE] ${userId} and ${match.id} marked 'pending'`);
    // Retrieve user details for notification
    const [userA, userB] = await Promise.all([
      User.findById(userId),
      User.findById(match.id)
    ]);
    console.log(`[MATCH NOTIFICATION] Sending to:`, {
      userA: userA.username,
      userB: userB.username
    });
    // Notify both users: one gets a prompt, the other waits
    io.to(activeUsers.get(userId).socketId).emit('match-found', {
      chatId,
      user: {
        id: match.id,
        username: userB.username,
        interests: userB.interests
      },
      promptUser: true
    });
    io.to(match.socketId).emit('match-found', {
      chatId,
      user: {
        id: userId,
        username: userA.username,
        interests: userA.interests
      },
      promptUser: false
    });
    console.log(`[MATCH COMPLETE] Successfully paired ${userId} and ${match.id}`);
    return { _id: chatId };
  } catch (error) {
    console.error('[MATCH HANDLING ERROR]', error);
    throw error;
  }
}


// --- Routes ---
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/chat', require('./routes/chatRoutes'));
app.use('/api/post', require('./routes/postRoutes'));

app.get('/', (req, res) => {
  res.send('Circle App API is running');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n[SERVER] Running on port ${PORT}`);
});
