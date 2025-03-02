const express = require('express');
const router = express.Router();
const { 
  register, 
  login, 
  getMe, 
  updateProfile, 
  updateChatPreference 
} = require('../controllers/authController');

const { protect } = require('../middleware/authMiddleware');


// Public routes
router.post('/register', register);
router.post('/login', login);

// Protected routes
router.get('/me', protect, getMe);
router.put('/profile', protect, updateProfile);
router.put('/chat-preference', protect, updateChatPreference);

module.exports = router;