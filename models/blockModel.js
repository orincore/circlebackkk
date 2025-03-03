// blockModel.js
const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema({
    blocker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    blocked: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now }
  });
  
  module.exports = mongoose.model('Block', blockSchema);
