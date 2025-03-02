const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const authMiddleware = require('../middleware/authMiddleware');

// Apply security headers to all routes
router.use(authMiddleware.securityHeaders);

// Apply request logging if needed
// router.use(authMiddleware.logRequest);

// All routes require authentication
router.use(authMiddleware.protect);

// Routes with file uploads
router.post('/', 
  authMiddleware.rateLimit.posts,
  authMiddleware.rateLimit.uploads,
  authMiddleware.uploadMedia({ maxCount: 5, fieldName: 'media' }),
  postController.createPost
);

// Regular routes (no file uploads)
router.get('/', postController.getAllPosts);
router.get('/:id', postController.getPostById);

// Routes that need ownership verification
router.put('/:id', 
  authMiddleware.checkPostOwnership,
  postController.updatePost
);

router.delete('/:id', 
  authMiddleware.checkPostOwnership,
  postController.deletePost
);

// Social interaction routes
router.put('/:id/like', postController.likePost);
router.post('/:id/comment', postController.addComment);

// User-specific routes
router.get('/user/:userId', postController.getUserPosts);

module.exports = router;