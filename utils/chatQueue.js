// utils/chatQueue.js
class ChatQueue {
    constructor() {
      this.queue = new Map();
    }
  
    addUser(userId, preferences) {
      this.queue.set(userId, {
        ...preferences,
        timestamp: Date.now()
      });
    }
  
    removeUser(userId) {
      this.queue.delete(userId);
    }
  
    findBestMatch(currentUserId, currentPreferences) {
      for (const [userId, preferences] of this.queue.entries()) {
        if (userId !== currentUserId &&
            preferences.chatPreference === currentPreferences.chatPreference &&
            preferences.interests.some(interest => 
              currentPreferences.interests.includes(interest))) {
          return userId;
        }
      }
      return null;
    }
  }
  
  module.exports = new ChatQueue();
