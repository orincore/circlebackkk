const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const { connectDB } = require('./config/db');
const User = require('./models/userModel');
const Chat = require('./models/chatModel');
const { handleMessage, createChatSession } = require('./controllers/chatController');

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

// Apply CORS middleware
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
  console.log(`[CONNECTION] New connection: ${socket.id}`);

  // Authentication handler
  socket.on('authenticate', async ({ userId }) => {
    try {
      console.log(`[AUTH] Attempting authentication for: ${userId}`);
      const user = await User.findById(userId);
      
      if (!user) {
        console.log(`[AUTH FAILED] User not found: ${userId}`);
        return;
      }

      const userData = {
        socketId: socket.id,
        interests: user.interests.map(i => i.toLowerCase()),
        chatPreference: user.chatPreference,
        status: 'online'
      };

      activeUsers.set(userId.toString(), userData);
      console.log(`[AUTH SUCCESS] User authenticated: ${userId}`, userData);

      await User.findByIdAndUpdate(userId, { 
        online: true,
        chatStatus: 'online',
        lastActive: new Date()
      });

    } catch (error) {
      console.error('[AUTH ERROR]', error);
    }
  });

  // Start matchmaking handler
  socket.on('start-search', async ({ userId }) => {
    try {
      console.log(`[SEARCH] Starting search for: ${userId}`);
      const user = await User.findById(userId);
      
      if (!user) {
        console.log(`[SEARCH FAILED] User not found: ${userId}`);
        return;
      }

      const userData = {
        socketId: socket.id,
        interests: user.interests.map(i => i.toLowerCase()),
        chatPreference: user.chatPreference,
        status: 'searching'
      };

      activeUsers.set(userId.toString(), userData);
      console.log(`[SEARCH STARTED] User data:`, userData);

      const interval = setInterval(async () => {
        console.log(`[MATCHMAKING] Checking matches for ${userId}...`);
        try {
          const match = await findMatch(userId);
          
          if (match) {
            console.log(`[MATCH FOUND] For ${userId}:`, match);
            clearInterval(interval);
            matchIntervals.delete(userId.toString());
            handleMatchFound(userId, match);
          } else {
            console.log(`[NO MATCH] No matches found for ${userId}`);
          }
        } catch (error) {
          console.error('[MATCHMAKING ERROR]', error);
        }
      }, 3000);

      matchIntervals.set(userId.toString(), interval);
      console.log(`[INTERVAL SET] For ${userId}`);

      const cleanup = () => {
        console.log(`[CLEANUP] Initiating for ${userId}`);
        cleanupSearch(userId);
      };

      socket.once('disconnect', cleanup);
      socket.once('end-search', cleanup);

    } catch (error) {
      console.error('[SEARCH ERROR]', error);
    }
  });

  // Message handler
  socket.on('send-message', async ({ chatId, senderId, content }) => {
    try {
      console.log(`[MESSAGE] Received from ${senderId} in ${chatId}`);
      const result = await handleMessage({ chatId, senderId, content });
      
      if (!result.success) {
        console.log(`[MESSAGE FAILED] Chat: ${chatId}`, result.error);
        return;
      }

      const receiverId = result.receiverId.toString();
      const receiverData = activeUsers.get(receiverId);
      
      if (receiverData) {
        console.log(`[MESSAGE SENT] To ${receiverId} in ${chatId}`);
        io.to(receiverData.socketId).emit('new-message', {
          chatId,
          message: result.message
        });
      } else {
        console.log(`[MESSAGE FAILED] Receiver offline: ${receiverId}`);
      }
    } catch (error) {
      console.error('[MESSAGE ERROR]', error);
    }
  });

  // Disconnect handler
  socket.on('disconnect', async () => {
    console.log(`[DISCONNECT] Socket: ${socket.id}`);
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

// Matchmaking algorithm
async function findMatch(userId) {
  try {
    console.log(`[FIND MATCH] Starting for ${userId}`);
    const searcher = activeUsers.get(userId.toString());
    
    if (!searcher) {
      console.log(`[MATCH FAIL] Searcher ${userId} not in active users`);
      return null;
    }

    if (searcher.status !== 'searching') {
      console.log(`[MATCH FAIL] Searcher ${userId} status: ${searcher.status}`);
      return null;
    }

    console.log(`[MATCH PARAMS] For ${userId}:`, {
      interests: searcher.interests,
      preference: searcher.chatPreference
    });

    const potentialMatches = [];
    
    for (const [id, candidate] of activeUsers.entries()) {
      if (id === userId.toString()) continue;

      console.log(`[CANDIDATE] Checking ${id}`, {
        status: candidate.status,
        interests: candidate.interests,
        preference: candidate.chatPreference
      });

      if (candidate.status === 'searching' && candidate.chatPreference === searcher.chatPreference) {
        const commonInterests = candidate.interests.filter(interest =>
          searcher.interests.includes(interest)
        );

        console.log(`[INTEREST CHECK] Between ${userId} and ${id}`, {
          searcher: searcher.interests,
          candidate: candidate.interests,
          common: commonInterests
        });

        if (commonInterests.length > 0) {
          console.log(`[POTENTIAL MATCH] Found between ${userId} and ${id}`);
          potentialMatches.push({ id, ...candidate });
        }
      }
    }

    console.log(`[MATCH RESULTS] For ${userId}: ${potentialMatches.length} matches`);
    return potentialMatches.length > 0 
      ? potentialMatches[Math.floor(Math.random() * potentialMatches.length)]
      : null;

  } catch (error) {
    console.error('[MATCH ERROR]', error);
    return null;
  }
}

// Handle successful match
async function handleMatchFound(userId, match) {
  try {
    console.log(`[CHAT CREATION] Starting for ${userId} and ${match.id}`);
    const { chat } = await createChatSession(userId, match.id, activeUsers.get(userId).chatPreference);
    
    console.log(`[STATUS UPDATE] Marking ${userId} and ${match.id} as in_chat`);
    activeUsers.set(userId.toString(), { ...activeUsers.get(userId), status: 'in_chat' });
    activeUsers.set(match.id, { ...match, status: 'in_chat' });

    const userA = await User.findById(userId);
    const userB = await User.findById(match.id);

    console.log(`[MATCH NOTIFICATION] Sending to both users`, {
      chatId: chat._id,
      users: [userA.username, userB.username]
    });

    io.to(activeUsers.get(userId).socketId).emit('match-found', {
      chatId: chat._id,
      user: {
        id: match.id,
        username: userB.username,
        interests: userB.interests
      }
    });

    io.to(match.socketId).emit('match-found', {
      chatId: chat._id,
      user: {
        id: userId,
        username: userA.username,
        interests: userA.interests
      }
    });

    console.log(`[MATCH COMPLETE] Created chat ${chat._id}`);
    return chat;
    
  } catch (error) {
    console.error('[MATCH HANDLING ERROR]', error);
    throw error;
  }
}

// Cleanup function
function cleanupSearch(userId) {
  console.log(`[CLEANUP] Starting for ${userId}`);
  const interval = matchIntervals.get(userId.toString());
  
  if (interval) {
    console.log(`[CLEANUP] Clearing interval for ${userId}`);
    clearInterval(interval);
  }
  
  matchIntervals.delete(userId.toString());
  activeUsers.delete(userId.toString());
  console.log(`[CLEANUP COMPLETE] For ${userId}`);
}

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/chat', require('./routes/chatRoutes'));
app.use('/api/post', require('./routes/postRoutes'));

// Default route
app.get('/', (req, res) => {
  res.send('Circle App API is running');
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});
