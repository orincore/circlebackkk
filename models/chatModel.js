const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  chatType: {
    type: String,
    enum: ['Friendship', 'Dating'],
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastMessage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message'
  },
  unreadCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

chatSchema.virtual('messages', {
  ref: 'Message',
  localField: '_id',
  foreignField: 'chat'
});

module.exports = mongoose.model('Chat', chatSchema);
