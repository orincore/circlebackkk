const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const { Types: { ObjectId } } = mongoose;
const ChatQueue = require('./utils/chatQueue');
const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const { connectDB } = require('./config/db');
const postRoutes = require('./routes/postRoutes');
const User = require('./models/userModel');
const Chat = require('./models/chatModel');
const { handleMessage, createChatSession } = require('./controllers/chatController');
const matchmakingQueue = new Map();


// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: '*',
  credentials: true,
  optionsSuccessStatus: 200
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Configure Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }
});

// Connect to MongoDB
connectDB();

// Middleware
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/post', postRoutes);

// Real-time Chat System ----------------------------------------------------
const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Authentication middleware
  socket.on('authenticate', async ({ userId }) => {
    try {
      const user = await User.findById(userId);
      if (!user) return;

      activeUsers.set(userId.toString(), {
        socketId: socket.id,
        interests: user.interests,
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

  // Matchmaking System
  socket.on('start-search', async ({ userId }) => {
    try {
      const user = await User.findById(userId);
      if (!user) return;
  
      // Add user to queue
      matchmakingQueue.set(userId.toString(), {
        socketId: socket.id,
        interests: user.interests.map(i => i.toLowerCase()),
        chatPreference: user.chatPreference
      });
  
      // Immediate match attempt
      const match = Array.from(matchmakingQueue.entries())
        .find(([id, data]) => 
          id !== userId.toString() &&
          data.chatPreference === user.chatPreference &&
          data.interests.some(i => user.interests.includes(i))
        );
  
      if (match) {
        const [matchId, matchData] = match;
        
        // Create chat session
        const { chat } = await createChatSession(userId, matchId, user.chatPreference);
        
        // Notify both users
        io.to(socket.id).emit('match-found', { 
          chatId: chat._id, 
          user: matchData 
        });
        io.to(matchData.socketId).emit('match-found', { 
          chatId: chat._id, 
          user: { 
            id: user._id, 
            username: user.username, 
            interests: user.interests 
          }
        });
  
        // Remove from queue
        matchmakingQueue.delete(userId.toString());
        matchmakingQueue.delete(matchId);
      }
  
    } catch (error) {
      console.error('Matchmaking error:', error);
      socket.emit('match-error', { message: 'Failed to find match' });
    }
  });
  

  // Message Handling
  socket.on('send-message', async ({ chatId, senderId, content }) => {
    try {
      const result = await handleMessage({ chatId, senderId, content });
      if (!result.success) return;

      const receiverSocket = activeUsers.get(result.receiverId.toString())?.socketId;
      if (receiverSocket) {
        io.to(receiverSocket).emit('new-message', {
          chatId,
          message: result.message
        });
      }
    } catch (error) {
      console.error('Message handling error:', error);
    }
  });

  // Disconnection Handler
  socket.on('disconnect', async () => {
    for (const [userId, data] of activeUsers.entries()) {
      if (data.socketId === socket.id) {
        activeUsers.delete(userId);
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

// Matchmaking Algorithm
async function findMatch(userId, userData) {
  console.log(`Finding match for user: ${userId}`);
  
  // Normalize interests to lowercase
  const userInterests = userData.interests.map(interest => interest.toLowerCase());
  
  // Array to store potential matches
  const potentialMatches = [];
  
  for (const [id, data] of activeUsers.entries()) {
    if (id !== userId && data.status === 'searching') {
      // Normalize potential match's interests
      const matchInterests = data.interests.map(interest => interest.toLowerCase());
      
      // Check for at least one common interest
      const hasCommonInterest = matchInterests.some(interest => 
        userInterests.includes(interest)
      );

      // Check if chat preferences match
      if (hasCommonInterest && data.chatPreference === userData.chatPreference) {
        console.log(`Potential match found: ${id}`);
        potentialMatches.push({ id, ...data });
      }
    }
  }

  // If no matches found, return null
  if (potentialMatches.length === 0) {
    console.log('No potential matches found');
    return null;
  }

  // Simple random match selection
  const match = potentialMatches[Math.floor(Math.random() * potentialMatches.length)];
  console.log(`Selected match: ${match.id}`);

  // Update status of both users to 'in_chat'
  activeUsers.set(match.id, { ...match, status: 'in_chat' });
  activeUsers.set(userId, { ...userData, status: 'in_chat' });

  return match;
}

// Default route
app.get('/', (req, res) => {
  res.send('Circle App API is running');
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
