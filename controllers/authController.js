const User = require('../models/userModel');
const jwt = require('jsonwebtoken');

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE
  });
};

// Register a new user
exports.register = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      username,
      email,
      phoneNumber,
      password,
      dateOfBirth,
      gender,
      location,
      interests
    } = req.body;

    // Check if username, email, or phone already exists
    const userExists = await User.findOne({
      $or: [
        { email },
        { username },
        { phoneNumber }
      ]
    });

    if (userExists) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email, username, or phone number'
      });
    }

    // Create new user
    const user = await User.create({
      firstName,
      lastName,
      username,
      email,
      phoneNumber,
      password,
      dateOfBirth,
      gender,
      location,
      interests,
      profileCreatedAt: Date.now()
    });

    // Generate token
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        email: user.email,
        phoneNumber: user.phoneNumber,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        location: user.location,
        interests: user.interests,
        profileCreatedAt: user.profileCreatedAt,
        chatPreference: user.chatPreference
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Login user with username and password
exports.login = async (req, res) => {
    try {
      const { username, password } = req.body;
  
      // Validate input
      if (!username?.trim() || !password?.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Please provide both username and password'
        });
      }
  
      // Clean inputs
      const cleanUsername = username.trim().toLowerCase();
      const cleanPassword = password.trim();
  
      // Find user by username
      const user = await User.findOne({ username: cleanUsername })
        .select('+password +loginAttempts +accountLocked')
        .lean();
  
      // Account lock check
      if (user?.accountLocked && user.lockUntil > Date.now()) {
        const remainingTime = Math.ceil((user.lockUntil - Date.now()) / (60 * 1000));
        return res.status(403).json({
          success: false,
          message: `Account locked. Try again in ${remainingTime} minutes`
        });
      }
  
      // Validate credentials
      if (!user || !(await User.prototype.matchPassword.call(user, cleanPassword))) {
        // Update failed attempts only if user exists
        if (user) {
          await User.findByIdAndUpdate(user._id, {
            $inc: { loginAttempts: 1 },
            $set: { 
              accountLocked: user.loginAttempts + 1 >= 5,
              lockUntil: user.loginAttempts + 1 >= 5 ? Date.now() + 15 * 60 * 1000 : null
            }
          });
        }
        
        return res.status(401).json({
          success: false,
          message: 'Invalid username or password'
        });
      }
  
      // Reset security counters
      await User.findByIdAndUpdate(user._id, {
        loginAttempts: 0,
        accountLocked: false,
        lockUntil: null,
        lastActive: Date.now()
      });
  
      // Generate token
      const token = generateToken(user._id);
  
      // Return user data without sensitive information
      const userData = {
        _id: user._id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        profileCreatedAt: user.profileCreatedAt
      };
  
      res.status(200).json({
        success: true,
        token,
        user: userData
      });
  
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({
        success: false,
        message: 'Login failed. Please try again later.'
      });
    }
  };
  
  // Get current user profile
  exports.getMe = async (req, res) => {
    try {
      const user = await User.findById(req.user.id)
        .select('-password -loginAttempts -accountLocked -lockUntil');
  
      res.status(200).json({
        success: true,
        user
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch user profile'
      });
    }
  };
  
// Update user profile
exports.updateProfile = async (req, res) => {
  try {
    const updatableFields = [
      'firstName', 'lastName', 'location', 
      'interests', 'chatPreference'
    ];
    
    const updateData = {};
    
    // Only allow certain fields to be updated
    Object.keys(req.body).forEach(key => {
      if (updatableFields.includes(key)) {
        updateData[key] = req.body[key];
      }
    });

    const user = await User.findByIdAndUpdate(
      req.user.id,
      updateData,
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Update chat preference (Friendship/Dating)
exports.updateChatPreference = async (req, res) => {
  try {
    const { chatPreference } = req.body;

    if (!chatPreference || !['Friendship', 'Dating'].includes(chatPreference)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid chat preference (Friendship or Dating)'
      });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { chatPreference },
      { new: true }
    );

    res.status(200).json({
      success: true,
      chatPreference: user.chatPreference
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};