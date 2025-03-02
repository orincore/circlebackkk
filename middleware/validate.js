// Add middleware to verify request body format
const validateLoginBody = (req, res, next) => {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Invalid request format'
      });
    }
    
    const { credential, password } = req.body;
    
    if (typeof credential !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Invalid data types for credentials'
      });
    }
    
    next();
  };