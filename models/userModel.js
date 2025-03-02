const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const validator = require('validator');

const interestsList = [
  'Photography', 'Travel', 'Food', 'Fashion', 'Technology',
  'Art', 'Music', 'Sports', 'Fitness', 'Books', 'Movies',
  'Gaming', 'Nature', 'Science', 'Politics', 'Business'
];

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true
  },
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true
  },
  avatar: {
    type: String,
    default: 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_1280.png'
  },
  bio: {
    type: String,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    validate: [validator.isEmail, 'Please provide a valid email']
  },
  phoneNumber: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 8,
    select: false
  },
  dateOfBirth: {
    type: Date,
    required: [true, 'Date of birth is required']
  },
  profileCreatedAt: {
    type: Date,
    default: Date.now
  },
  gender: {
    type: String,
    required: [true, 'Gender is required'],
    enum: ['Male', 'Female', 'Other', 'Prefer not to say']
  },
  location: {
    type: String,
    required: [true, 'Location is required']
  },
  active: {
    type: Boolean,
    default: true,
    select: false
  },
  passwordChangedAt: Date,

  interests: {
    type: [String],
    enum: interestsList,
    validate: {
      validator: function(interests) {
        return interests.length > 0;
      },
      message: 'Please select at least one interest'
    }
  },
  chatPreference: {
    type: String,
    enum: ['Friendship', 'Dating'],
    default: 'Friendship'
  },
  online: {
    type: Boolean,
    default: false
  },
  lastActive: {
    type: Date,
    default: Date.now
  },
  loginAttempts: {
    type: Number,
    required: true,
    default: 0
  },
  followers: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'User',
    default: [],
    index: true
  },
  following: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'User',
    default: [],
    index: true
  },
  postsCount: {
    type: Number,
    default: 0
  },
  accountLocked: {
    type: Boolean,
    default: false
  },
  lockUntil: {
    type: Date
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Add virtuals for follower/following counts
userSchema.virtual('followerCount').get(function() {
  return this.followers?.length || 0;
});

userSchema.virtual('followingCount').get(function() {
  return this.following?.length || 0;
});

// Add instance method for follow functionality
userSchema.methods.followUser = async function(userId) {
  if (!this.following.includes(userId)) {
    this.following.push(userId);
    await this.save();
  }
};

// Add instance method for unfollow functionality
userSchema.methods.unfollowUser = async function(userId) {
  this.following = this.following.filter(id => !id.equals(userId));
  await this.save();
};

// Add static method to increment post count
userSchema.statics.incrementPostCount = async function(userId) {
  await this.findByIdAndUpdate(userId, {
    $inc: { postsCount: 1 }
  });
};

// Add static method to decrement post count
userSchema.statics.decrementPostCount = async function(userId) {
  await this.findByIdAndUpdate(userId, {
    $inc: { postsCount: -1 }
  });
};

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    return next();
  }
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Method to compare entered password with stored hash
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model('User', userSchema);

module.exports = User;