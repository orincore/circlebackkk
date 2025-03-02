const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const Chat = require('../models/chatModel');
const Message = require('../models/messageModel');

module.exports = (io) => {
  // Authentication middleware for socket.io
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication error'));
      }
      
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);
      
      if (!user) {
        return next(new Error('User not found'));
      }
      
      socket.user = user;
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.user;
    
    console.log(`User connected: ${user.username}`);
    
    // Update user's online status
    await User.findByIdAndUpdate(user._id, { online: true, lastActive: Date.now() });
    
    // Join personal room for receiving messages
    socket.join(user._id.toString());
    
    // Join all active chat rooms
    const userChats = await Chat.find({
      participants: user._id,
      isActive: true
    });
    
    userChats.forEach(chat => {
      socket.join(chat._id.toString());
    });
    
    // Handle sending messages
    socket.on('sendMessage', async (data) => {
      try {
        const { chatId, content } = data;
        
        // Find chat and verify user is a participant
        const chat = await Chat.findOne({
          _id: chatId,
          participants: user._id,
          isActive: true
        });
        
        if (!chat) {
          socket.emit('error', { message: 'Chat not found or inactive' });
          return;
        }
        
        // Create new message
        const newMessage = await Message.create({
          chat: chatId,
          sender: user._id,
          content,
          readBy: [user._id]
        });
        
        // Update last message in chat
        chat.lastMessage = newMessage._id;
        await chat.save();
        
        // Populate message details for frontend
        const populatedMessage = await Message.findById(newMessage._id)
          .populate({
            path: 'sender',
            select: 'firstName lastName username'
          });
        
        // Broadcast message to all users in chat
        io.to(chatId).emit('newMessage', populatedMessage);
        
        // Update unread status for other participant
        const otherParticipant = chat.participants.find(
          p => !p.equals(user._id)
        );
        
        // Notify other participant
        if (otherParticipant) {
          io.to(otherParticipant.toString()).emit('messageNotification', {
            chatId,
            message: populatedMessage
          });
        }
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });
    
    // Handle message read status
    socket.on('markAsRead', async (data) => {
      try {
        const { chatId } = data;
        
        // Update all unread messages in this chat
        await Message.updateMany(
          { 
            chat: chatId, 
            sender: { $ne: user._id },
            readBy: { $ne: user._id }
          },
          { $push: { readBy: user._id } }
        );
        
        // Notify other participant that messages were read
        const chat = await Chat.findById(chatId);
        if (chat) {
          const otherParticipant = chat.participants.find(
            p => !p.equals(user._id)
          );
          
          if (otherParticipant) {
            io.to(otherParticipant.toString()).emit('messagesRead', {
              chatId,
              readBy: user._id
            });
          }
        }
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });
    
    // User is typing indicator
    socket.on('typing', (chatId) => {
      socket.to(chatId).emit('userTyping', {
        chatId,
        user: user._id
      });
    });
    
    // User stopped typing
    socket.on('stopTyping', (chatId) => {
      socket.to(chatId).emit('userStoppedTyping', {
        chatId,
        user: user._id
      });
    });
    
    // Join a new chat room
    socket.on('joinChat', (chatId) => {
      socket.join(chatId);
    });
    
    // Leave a chat room
    socket.on('leaveChat', (chatId) => {
      socket.leave(chatId);
    });
    
    // Find a new random match
    socket.on('findRandomMatch', async () => {
      // This is handled via the REST API endpoint
      // But we notify the user when a match is found via socket
      socket.emit('waitingForMatch');
    });
    
    // Handle random chat match acceptance
    socket.on('acceptMatch', async (chatId) => {
      socket.join(chatId);
      io.to(chatId).emit('matchAccepted', { chatId });
    });
    
        // Handle random chat match rejection
        socket.on('rejectMatch', async (chatId) => {
            try {
              // Mark chat as inactive
              await Chat.findByIdAndUpdate(chatId, { isActive: false });
              
              // Notify other participant
              io.to(chatId).emit('matchRejected', { chatId });
              
              // Leave chat room
              socket.leave(chatId);
            } catch (error) {
              socket.emit('error', { message: error.message });
            }
          });
      
          // Handle user disconnect
          socket.on('disconnect', async () => {
            try {
              console.log(`User disconnected: ${user.username}`);
              
              // Update user's online status and last active time
              await User.findByIdAndUpdate(user._id, { 
                online: false,
                lastActive: Date.now()
              });
      
              // Notify all chat participants about user's offline status
              const activeChats = await Chat.find({
                participants: user._id,
                isActive: true
              });
      
              activeChats.forEach(chat => {
                chat.participants.forEach(participant => {
                  if (!participant.equals(user._id)) {
                    io.to(participant.toString()).emit('userStatusChanged', {
                      userId: user._id,
                      online: false
                    });
                  }
                });
              });
            } catch (error) {
              console.error('Disconnect error:', error.message);
            }
          });
      
          // Handle connection errors
          socket.on('error', (error) => {
            console.error(`Socket error for user ${user.username}:`, error.message);
          });
        }); // End of io.on('connection')
      
        return io;
      }; // End of module.exports