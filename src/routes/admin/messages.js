const express = require('express');
const { ObjectId } = require('mongodb');
const { requireAdmin } = require('../../middleware/adminAuth');
const { getDB } = require('../../db/mongo');

const router = express.Router();

// All routes require admin authentication
router.use(requireAdmin);

// ─── GET /admin/messages ──────────────────────────────────────────────────────
// Returns all broadcast messages (most recent first).
router.get('/', async (req, res) => {
  const db = getDB();
  try {
    const messages = await db
      .collection('broadcast_messages')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      messages: messages.map(formatMessage),
    });
  } catch (err) {
    console.error('GET /admin/messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ─── POST /admin/messages ─────────────────────────────────────────────────────
// Creates a new broadcast message.
// Body: { title, body, scheduledAt? }
//   scheduledAt: ISO 8601 string or null. If in the future the message is
//   stored as published but won't appear in GET /messages until that time.
router.post('/', async (req, res) => {
  const db = getDB();
  const { title, body, scheduledAt } = req.body;

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'body is required' });
  }

  let parsedScheduledAt = null;
  if (scheduledAt) {
    parsedScheduledAt = new Date(scheduledAt);
    if (isNaN(parsedScheduledAt.getTime())) {
      return res.status(400).json({ error: 'scheduledAt must be a valid ISO 8601 date string' });
    }
  }

  const now = new Date();
  const doc = {
    title: title.trim(),
    body: body.trim(),
    status: 'published',
    scheduledAt: parsedScheduledAt,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    createdBy: req.admin.email,
  };

  try {
    const result = await db.collection('broadcast_messages').insertOne(doc);
    res.status(201).json({ message: formatMessage({ ...doc, _id: result.insertedId }) });
  } catch (err) {
    console.error('POST /admin/messages error:', err);
    res.status(500).json({ error: 'Failed to create message' });
  }
});

// ─── PATCH /admin/messages/:id ────────────────────────────────────────────────
// Updates title, body, scheduledAt, or status on an existing message.
router.patch('/:id', async (req, res) => {
  const db = getDB();
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  const { title, body, scheduledAt, status } = req.body;
  const updates = { updatedAt: new Date() };

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title must be a non-empty string' });
    }
    updates.title = title.trim();
  }

  if (body !== undefined) {
    if (typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'body must be a non-empty string' });
    }
    updates.body = body.trim();
  }

  if (scheduledAt !== undefined) {
    if (scheduledAt === null) {
      updates.scheduledAt = null;
    } else {
      const parsed = new Date(scheduledAt);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'scheduledAt must be a valid ISO 8601 date string or null' });
      }
      updates.scheduledAt = parsed;
    }
  }

  if (status !== undefined) {
    if (!['published', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'status must be "published" or "archived"' });
    }
    updates.status = status;
  }

  try {
    const result = await db
      .collection('broadcast_messages')
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updates },
        { returnDocument: 'after' }
      );

    if (!result) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ message: formatMessage(result) });
  } catch (err) {
    console.error('PATCH /admin/messages/:id error:', err);
    res.status(500).json({ error: 'Failed to update message' });
  }
});

// ─── DELETE /admin/messages/:id ───────────────────────────────────────────────
// Permanently deletes a broadcast message.
router.delete('/:id', async (req, res) => {
  const db = getDB();
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  try {
    const result = await db
      .collection('broadcast_messages')
      .deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Clean up any dismiss records for this message
    await db.collection('message_reads').deleteMany({ messageId: new ObjectId(id) });

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/messages/:id error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMessage(m) {
  return {
    id: m._id.toString(),
    title: m.title,
    body: m.body,
    status: m.status,
    scheduledAt: m.scheduledAt || null,
    publishedAt: m.publishedAt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    createdBy: m.createdBy || null,
  };
}

module.exports = router;
