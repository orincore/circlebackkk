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
  console.log(`New connection: ${socket.id}`);

  // Authentication handler
  socket.on('authenticate', async ({ userId }) => {
    try {
      const user = await User.findById(userId);
      if (!user) return;

      activeUsers.set(userId.toString(), {
        socketId: socket.id,
        interests: user.interests.map(i => i.toLowerCase()),
        chatPreference: user.chatPreference,
        status: 'online'
      });

      await User.findByIdAndUpdate(userId, { 
        online: true,
        chatStatus: 'online',
        lastActive: new Date()
      });

      console.log(`User authenticated: ${userId}`);
    } catch (error) {
      console.error('Authentication error:', error);
    }
  });

  // Start matchmaking handler
  socket.on('start-search', async ({ userId }) => {
    try {
      const user = await User.findById(userId);
      if (!user) return;

      // Add/update user in activeUsers
      activeUsers.set(userId.toString(), {
        socketId: socket.id,
        interests: user.interests.map(i => i.toLowerCase()),
        chatPreference: user.chatPreference,
        status: 'searching'
      });

      console.log(`User ${userId} started searching`);

      // Create matchmaking interval
      const interval = setInterval(async () => {
        const match = await findMatch(userId);
        if (match) {
          clearInterval(interval);
          matchIntervals.delete(userId.toString());
          handleMatchFound(userId, match);
        }
      }, 3000); // Check every 3 seconds

      matchIntervals.set(userId.toString(), interval);

      // Cleanup on disconnect
      socket.once('disconnect', () => cleanupSearch(userId));
      
      // Handle manual search cancellation
      socket.once('end-search', () => cleanupSearch(userId));

    } catch (error) {
      console.error('Matchmaking error:', error);
    }
  });

  // Message handler
  socket.on('send-message', async ({ chatId, senderId, content }) => {
    try {
      const result = await handleMessage({ chatId, senderId, content });
      if (!result.success) return;

      const receiverId = result.receiverId.toString();
      const receiverData = activeUsers.get(receiverId);
      
      if (receiverData) {
        io.to(receiverData.socketId).emit('new-message', {
          chatId,
          message: result.message
        });
      }
    } catch (error) {
      console.error('Message handling error:', error);
    }
  });

  // Disconnect handler
  socket.on('disconnect', async () => {
    for (const [userId, data] of activeUsers.entries()) {
      if (data.socketId === socket.id) {
        cleanupSearch(userId);
        await User.findByIdAndUpdate(userId, {
          online: false,
          chatStatus: 'offline',
          lastActive: new Date()
        });
        console.log(`User disconnected: ${userId}`);
        break;
      }
    }
  });
});

// Matchmaking algorithm
async function findMatch(userId) {
  const searcher = activeUsers.get(userId.toString());
  if (!searcher || searcher.status !== 'searching') return null;

  const potentialMatches = [];
  
  for (const [id, candidate] of activeUsers.entries()) {
    if (id !== userId.toString() && 
        candidate.status === 'searching' &&
        candidate.chatPreference === searcher.chatPreference) {
      
      const commonInterests = candidate.interests.filter(interest =>
        searcher.interests.includes(interest)
      );

      if (commonInterests.length > 0) {
        potentialMatches.push({ id, ...candidate });
      }
    }
  }

  if (potentialMatches.length === 0) return null;

  // Select random match
  const match = potentialMatches[Math.floor(Math.random() * potentialMatches.length)];
  return match;
}

// Handle successful match
async function handleMatchFound(userId, match) {
  try {
    const { chat } = await createChatSession(userId, match.id, activeUsers.get(userId).chatPreference);
    
    // Update user statuses
    activeUsers.set(userId.toString(), { ...activeUsers.get(userId), status: 'in_chat' });
    activeUsers.set(match.id, { ...match, status: 'in_chat' });

    // Notify both users
    io.to(activeUsers.get(userId).socketId).emit('match-found', {
      chatId: chat._id,
      user: match
    });

    io.to(match.socketId).emit('match-found', {
      chatId: chat._id,
      user: {
        id: userId,
        username: (await User.findById(userId)).username,
        interests: activeUsers.get(userId).interests
      }
    });

    console.log(`Match created between ${userId} and ${match.id}`);
  } catch (error) {
    console.error('Match creation error:', error);
  }
}

// Cleanup function
function cleanupSearch(userId) {
  const interval = matchIntervals.get(userId.toString());
  if (interval) clearInterval(interval);
  matchIntervals.delete(userId.toString());
  activeUsers.delete(userId.toString());
  console.log(`Search cleaned up for user: ${userId}`);
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
  console.log(`Server running on port ${PORT}`);
});
