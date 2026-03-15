const express = require('express');
const { ObjectId } = require('mongodb');
const { requireAuth } = require('../middleware/auth');
const { getDB } = require('../db/mongo');

const router = express.Router();

// All routes require a valid Firebase user token
router.use(requireAuth);

// ─── GET /messages ───────────────────────────────────────────────────────────
// Returns broadcast messages that are currently active (published, past their
// scheduledAt date) and not yet dismissed by this user.
router.get('/', async (req, res) => {
  const db = getDB();
  const now = new Date();

  try {
    // Find all published messages that are either unscheduled or past their send time
    const activeMessages = await db
      .collection('broadcast_messages')
      .find({
        status: 'published',
        $or: [
          { scheduledAt: null },
          { scheduledAt: { $exists: false } },
          { scheduledAt: { $lte: now } },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    if (activeMessages.length === 0) {
      return res.json({ messages: [] });
    }

    // Find which of those this user has already dismissed
    const messageIds = activeMessages.map(m => m._id);
    const reads = await db
      .collection('message_reads')
      .find({ uid: req.user.uid, messageId: { $in: messageIds } })
      .toArray();

    const dismissedSet = new Set(reads.map(r => r.messageId.toString()));

    const unread = activeMessages
      .filter(m => !dismissedSet.has(m._id.toString()))
      .map(m => ({
        id: m._id.toString(),
        title: m.title,
        body: m.body,
        publishedAt: m.publishedAt,
        scheduledAt: m.scheduledAt || null,
      }));

    res.json({ messages: unread });
  } catch (err) {
    console.error('GET /messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ─── POST /messages/:id/dismiss ──────────────────────────────────────────────
// Records that the authenticated user has dismissed a message.
// Idempotent — safe to call multiple times.
router.post('/:id/dismiss', async (req, res) => {
  const db = getDB();
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  try {
    await db.collection('message_reads').updateOne(
      { uid: req.user.uid, messageId: new ObjectId(id) },
      { $setOnInsert: { uid: req.user.uid, messageId: new ObjectId(id), dismissedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /messages/:id/dismiss error:', err);
    res.status(500).json({ error: 'Failed to dismiss message' });
  }
});

module.exports = router;
