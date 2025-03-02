const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Configure multer for temporary storage
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    const uploadDir = 'tmp/uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    const uniqueFilename = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueFilename);
  }
});

// File filter to accept only images and videos
const fileFilter = (req, file, cb) => {
  // Accept images and videos
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Only images and videos are allowed.'), false);
  }
};

// Create multer upload instance
const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max file size
  }
});

// Handle multer errors
exports.handleUploadErrors = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File size limit exceeded. Maximum allowed size is 50MB.'
      });
    }
    return res.status(400).json({
      success: false,
      message: `Upload error: ${err.message}`
    });
  } else if (err) {
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
  next();
};

// Authentication middleware
exports.protect = async (req, res, next) => {
  let token;
  
  // 1. Get token from multiple sources
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies?.token) {
    token = req.cookies.token;
  }

  // 2. Check token existence
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized access - No authentication token found'
    });
  }

  try {
    // 3. Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // 4. Check if user still exists
    const currentUser = await User.findById(decoded.id).select('+active +passwordChangedAt');
    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: 'User belonging to this token no longer exists'
      });
    }

    // 5. Check if user changed password after token was issued
    if (currentUser.passwordChangedAt) {
      const changedTimestamp = parseInt(
        currentUser.passwordChangedAt.getTime() / 1000,
        10
      );
      
      if (decoded.iat < changedTimestamp) {
        return res.status(401).json({
          success: false,
          message: 'Password was changed recently. Please log in again.'
        });
      }
    }

    // 6. Check account status
    if (!currentUser.active) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated. Please contact support.'
      });
    }

    // 7. Grant access
    req.user = currentUser;
    res.locals.user = currentUser;
    next();
  } catch (error) {
    // Handle specific JWT errors
    let errorMessage = 'Invalid authentication token';
    
    if (error instanceof jwt.TokenExpiredError) {
      errorMessage = 'Session expired. Please log in again.';
    } else if (error instanceof jwt.JsonWebTokenError) {
      errorMessage = 'Invalid token. Please log in again.';
    }

    console.error(`Authentication Error: ${error.message}`);
    
    return res.status(401).json({
      success: false,
      message: errorMessage,
      hint: error instanceof jwt.TokenExpiredError ? 
        'Token expired at: ' + error.expiredAt.toISOString() : 
        undefined
    });
  }
};

// Optional: Add security headers middleware
exports.securityHeaders = (req, res, next) => {
  // Set general security headers
  res.set({
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block'
  });
  
  // Set content security policy that allows AWS S3 resources
  const cspDirectives = [
    "default-src 'self'",
    `img-src 'self' data: ${process.env.AWS_S3_BUCKET_URL || '*.amazonaws.com'}`,
    `media-src 'self' ${process.env.AWS_S3_BUCKET_URL || '*.amazonaws.com'}`,
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Allow inline styles for UI
    "font-src 'self' data:"
  ];
  
  res.set('Content-Security-Policy', cspDirectives.join('; '));
  next();
};

// Middleware to check permission for specific post operations
exports.checkPostOwnership = async (req, res, next) => {
  try {
    const Post = require('../models/postModel');
    const postId = req.params.id;
    
    // Skip if no post ID is present in the request
    if (!postId) return next();
    
    const post = await Post.findById(postId);
    
    // If post doesn't exist, let the controller handle it
    if (!post) return next();
    
    // Check if user is the owner of the post
    if (post.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to perform this action on this post'
      });
    }
    
    // Add post to request for use in controller (avoids duplicate DB queries)
    req.post = post;
    next();
  } catch (error) {
    console.error('Error checking post ownership:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while checking permissions',
      error: error.message
    });
  }
};

// Rate limiting middleware for content uploads
exports.rateLimit = {
  // Middleware to limit number of posts per day
  posts: (req, res, next) => {
    const MAX_POSTS_PER_DAY = 50;
    const userId = req.user.id;
    
    // Get today's date (start of day)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const Post = require('../models/postModel');
    
    Post.countDocuments({
      user: userId,
      createdAt: { $gte: today }
    })
    .then(count => {
      if (count >= MAX_POSTS_PER_DAY) {
        return res.status(429).json({
          success: false,
          message: `You have reached your daily limit of ${MAX_POSTS_PER_DAY} posts`
        });
      }
      next();
    })
    .catch(err => {
      console.error('Error in rate limiting:', err);
      // Continue even if rate limiting fails
      next();
    });
  },
  
  // Middleware to limit uploads per minute (anti-spam)
  uploads: (req, res, next) => {
    const MAX_UPLOADS_PER_MINUTE = 10;
    const userId = req.user.id;
    
    // Check if upload tracking exists in memory
    if (!global.uploadTracker) {
      global.uploadTracker = {};
    }
    
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Clean up old entries
    for (const id in global.uploadTracker) {
      global.uploadTracker[id] = global.uploadTracker[id].filter(
        time => time > oneMinuteAgo
      );
      if (global.uploadTracker[id].length === 0) {
        delete global.uploadTracker[id];
      }
    }
    
    // Check current user's upload rate
    if (!global.uploadTracker[userId]) {
      global.uploadTracker[userId] = [];
    }
    
    if (global.uploadTracker[userId].length >= MAX_UPLOADS_PER_MINUTE) {
      return res.status(429).json({
        success: false,
        message: 'You are uploading too quickly. Please try again in a minute.'
      });
    }
    
    // Track this upload
    global.uploadTracker[userId].push(now);
    next();
  }
};

// File upload middleware for different media types
exports.uploadMedia = (options = {}) => {
  const maxCount = options.maxCount || 5;
  const fieldName = options.fieldName || 'media';
  
  return [
    upload.array(fieldName, maxCount),
    exports.handleUploadErrors
  ];
};

// Middleware to log API requests (useful for debugging)
exports.logRequest = (req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} | User: ${req.user?.id || 'Unauthenticated'}`);
  next();
};