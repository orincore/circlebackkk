const Post = require('../models/postModel');
const User = require('../models/userModel');
const AWS = require('aws-sdk');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');

// Configure AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

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

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max file size
  }
});

const uploadToS3 = async (file) => {
  const fileStream = fs.createReadStream(file.path);
  
  // Determine content type
  let contentType = file.mimetype;
  let folder = 'images';
  
  if (file.mimetype.startsWith('video/')) {
    folder = 'videos';
  }
  
  const uploadParams = {
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: `${folder}/${uuidv4()}-${file.originalname}`,
    Body: fileStream,
    ContentType: contentType
  };

  console.log('Upload Params:', uploadParams);
  
  try {
    const result = await s3.upload(uploadParams).promise();
    // Delete local file after upload
    fs.unlinkSync(file.path);
    return result.Location;
  } catch (error) {
    // Delete local file if upload fails
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
    throw error;
  }
};

exports.createPost = async (req, res) => {
  try {
    const { text } = req.body;
    const userId = req.user.id; // Assuming user ID comes from auth middleware
    
    // Verify valid MongoDB ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID format'
      });
    }
    
    // Create a new post document with text content
    const newPost = new Post({
      user: userId,
      text: text || '',
      mediaUrls: [],
      mediaTypes: [],
      likes: [],
      comments: []
    });
    
    // Handle media uploads if any
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileUrl = await uploadToS3(file);
        newPost.mediaUrls.push(fileUrl);
        
        // Add media type (image or video)
        if (file.mimetype.startsWith('image/')) {
          newPost.mediaTypes.push('image');
        } else if (file.mimetype.startsWith('video/')) {
          newPost.mediaTypes.push('video');
        }
      }
    }
    
    // Save the post to MongoDB
    await newPost.save();
    
    // Populate user details for response using MongoDB's populate
    const populatedPost = await Post.findById(newPost._id)
      .populate('user', 'username profilePicture')
      .lean();
    
    res.status(201).json({
      success: true,
      data: populatedPost
    });
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating post',
      error: error.message
    });
  }
};

exports.getAllPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    // Use MongoDB aggregation for efficient querying with pagination
    const posts = await Post.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'username profilePicture')
      .populate({
        path: 'comments.user',
        select: 'username profilePicture'
      })
      .lean();
    
    // Get total count using MongoDB countDocuments
    const totalPosts = await Post.countDocuments();
    
    res.status(200).json({
      success: true,
      data: posts,
      pagination: {
        totalPosts,
        totalPages: Math.ceil(totalPosts / limit),
        currentPage: page,
        postsPerPage: limit
      }
    });
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching posts',
      error: error.message
    });
  }
};

exports.getPostById = async (req, res) => {
  try {
    const postId = req.params.id;
    
    // Validate MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid post ID format'
      });
    }
    
    // Use MongoDB findById with populate for efficient fetching
    const post = await Post.findById(postId)
      .populate('user', 'username profilePicture')
      .populate({
        path: 'comments.user',
        select: 'username profilePicture'
      })
      .lean();
    
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: post
    });
  } catch (error) {
    console.error('Error fetching post:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching post',
      error: error.message
    });
  }
};

exports.updatePost = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;
    
    // Validate MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid post ID format'
      });
    }
    
    // Find post in MongoDB
    const post = await Post.findById(postId);
    
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }
    
    // Check if user is the owner of the post
    if (post.user.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'User not authorized to update this post'
      });
    }
    
    // Update text content if provided
    if (req.body.text !== undefined) {
      post.text = req.body.text;
    }
    
    // Save updates to MongoDB
    await post.save();
    
    // Return updated post
    const updatedPost = await Post.findById(postId)
      .populate('user', 'username profilePicture')
      .lean();
    
    res.status(200).json({
      success: true,
      data: updatedPost
    });
  } catch (error) {
    console.error('Error updating post:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating post',
      error: error.message
    });
  }
};

exports.deletePost = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;
    
    // Validate MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid post ID format'
      });
    }
    
    // Find post in MongoDB
    const post = await Post.findById(postId);
    
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }
    
    // Check if user is the owner of the post
    if (post.user.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'User not authorized to delete this post'
      });
    }
    
    // Delete media files from S3
    for (const mediaUrl of post.mediaUrls) {
      try {
        // Extract the key from the S3 URL
        const key = mediaUrl.split('/').slice(3).join('/');
        
        const deleteParams = {
          Bucket: process.env.AWS_S3_BUCKET_NAME,
          Key: key
        };
        
        await s3.deleteObject(deleteParams).promise();
      } catch (deleteError) {
        console.error('Error deleting file from S3:', deleteError);
        // Continue with post deletion even if S3 deletion fails
      }
    }
    
    // Use MongoDB findByIdAndDelete for atomic operation
    await Post.findByIdAndDelete(postId);
    
    res.status(200).json({
      success: true,
      message: 'Post deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting post',
      error: error.message
    });
  }
};

exports.likePost = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;
    
    // Validate MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid post ID format'
      });
    }
    
    // Find post in MongoDB
    const post = await Post.findById(postId);
    
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }
    
    // Use MongoDB's array methods to handle likes
    const likeIndex = post.likes.findIndex(
      like => like.toString() === userId
    );
    
    if (likeIndex === -1) {
      // Like the post - add to MongoDB array
      post.likes.push(userId);
    } else {
      // Unlike the post - remove from MongoDB array
      post.likes.splice(likeIndex, 1);
    }
    
    // Save to MongoDB
    await post.save();
    
    res.status(200).json({
      success: true,
      data: post.likes,
      likesCount: post.likes.length
    });
  } catch (error) {
    console.error('Error liking/unliking post:', error);
    res.status(500).json({
      success: false,
      message: 'Error liking/unliking post',
      error: error.message
    });
  }
};

exports.addComment = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;
    const { text } = req.body;
    
    // Validate MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid post ID format'
      });
    }
    
    // Find post in MongoDB
    const post = await Post.findById(postId);
    
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }
    
    // Create new comment with MongoDB subdocument
    const newComment = {
      _id: new mongoose.Types.ObjectId(), // Generate MongoDB ObjectId
      user: userId,
      text,
      createdAt: Date.now()
    };
    
    // Add to MongoDB array
    post.comments.push(newComment);
    
    // Save to MongoDB
    await post.save();
    
    // Fetch the comment with populated user data from MongoDB
    const updatedPost = await Post.findById(postId).populate({
      path: 'comments.user',
      select: 'username profilePicture'
    });
    
    // Find the newly added comment
    const addedComment = updatedPost.comments.id(newComment._id);
    
    res.status(201).json({
      success: true,
      data: addedComment
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({
      success: false,
      message: 'Error adding comment',
      error: error.message
    });
  }
};

exports.getUserPosts = async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Validate MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID format'
      });
    }
    
    // Verify user exists in MongoDB
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    // Use MongoDB query with user filter
    const posts = await Post.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'username profilePicture')
      .populate({
        path: 'comments.user',
        select: 'username profilePicture'
      })
      .lean();
    
    // Get user's post count from MongoDB
    const totalPosts = await Post.countDocuments({ user: userId });
    
    res.status(200).json({
      success: true,
      data: posts,
      pagination: {
        totalPosts,
        totalPages: Math.ceil(totalPosts / limit),
        currentPage: page,
        postsPerPage: limit
      }
    });
  } catch (error) {
    console.error('Error fetching user posts:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching user posts',
      error: error.message
    });
  }
};

// Middleware to handle file uploads
exports.uploadMedia = upload.array('media', 5); // Allow up to 5 files per post