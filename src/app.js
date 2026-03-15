const express = require('express');

const healthRouter = require('./routes/health');
const checkinsRouter = require('./routes/checkins');
const usersRouter = require('./routes/users');
const aiRouter = require('./routes/ai');
const messagesRouter = require('./routes/messages');
const adminMessagesRouter = require('./routes/admin/messages');

const app = express();

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Allow the admin portal (lunevoapp.com) to call the API from the browser.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = [
    'https://www.lunevoapp.com',
    'https://lunevoapp.com',
    // local dev
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ];
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);
app.use('/checkins', checkinsRouter);
app.use('/users', usersRouter);
app.use('/ai', aiRouter);
app.use('/messages', messagesRouter);
app.use('/admin/messages', adminMessagesRouter);

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
