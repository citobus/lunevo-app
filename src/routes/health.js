const express = require('express');
const router = express.Router();

// GET /health  — unauthenticated liveness check used by Railway
router.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
