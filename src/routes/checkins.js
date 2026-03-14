const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDB } = require('../db/mongo');

const router = express.Router();

// All routes below require a valid Firebase token
router.use(requireAuth);

// ─── GET /checkins ────────────────────────────────────────────────────────────
// Returns all check-ins for the authenticated user, newest first.
// Optional query params:
//   ?limit=N   (default 500)
//   ?days=N    (return only the last N days)
router.get('/', async (req, res) => {
  try {
    const db = getDB();
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);

    const filter = { uid: req.user.uid };

    if (req.query.days) {
      const days = parseInt(req.query.days);
      const since = new Date();
      since.setDate(since.getDate() - days);
      filter.timestamp = { $gte: since };
    }

    const checkins = await db
      .collection('checkins')
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    res.json(checkins);
  } catch (err) {
    console.error('GET /checkins error:', err);
    res.status(500).json({ error: 'Failed to fetch check-ins' });
  }
});

// ─── PUT /checkins ───────────────────────────────────────────────────────────
// Upserts a single check-in by uid + clientId.
// Body: { clientId, timestamp, phase, energy, focus, wellbeing, note?, updatedAt? }
// If a check-in with the same uid + clientId exists, it is replaced.
// Otherwise a new document is created.
router.put('/', async (req, res) => {
  try {
    const db = getDB();
    const { clientId, timestamp, phase, energy, focus, wellbeing, note, updatedAt } = req.body;

    if (!clientId || !phase || energy == null || focus == null || wellbeing == null) {
      return res.status(400).json({ error: 'Missing required fields: clientId, phase, energy, focus, wellbeing' });
    }

    const doc = {
      uid: req.user.uid,
      clientId,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      phase,
      energy: Number(energy),
      focus: Number(focus),
      wellbeing: Number(wellbeing),
      note: note || null,
      updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
    };

    const result = await db.collection('checkins').findOneAndUpdate(
      { uid: req.user.uid, clientId },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );

    res.json(result);
  } catch (err) {
    console.error('PUT /checkins error:', err);
    res.status(500).json({ error: 'Failed to upsert check-in' });
  }
});

// ─── POST /checkins/bulk ─────────────────────────────────────────────────────
// Bulk upserts check-ins by uid + clientId.
// Body: { checkins: [{ clientId, timestamp, phase, energy, focus, wellbeing, note?, updatedAt? }] }
// Returns { upsertedCount, modifiedCount }
router.post('/bulk', async (req, res) => {
  try {
    const db = getDB();
    const { checkins } = req.body;

    if (!Array.isArray(checkins) || checkins.length === 0) {
      return res.status(400).json({ error: 'Body must contain a non-empty checkins array' });
    }

    if (checkins.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 check-ins per bulk request' });
    }

    const ops = checkins
      .filter(c => c.clientId && c.phase && c.energy != null && c.focus != null && c.wellbeing != null)
      .map(c => ({
        updateOne: {
          filter: { uid: req.user.uid, clientId: c.clientId },
          update: {
            $set: {
              uid: req.user.uid,
              clientId: c.clientId,
              timestamp: c.timestamp ? new Date(c.timestamp) : new Date(),
              phase: c.phase,
              energy: Number(c.energy),
              focus: Number(c.focus),
              wellbeing: Number(c.wellbeing),
              note: c.note || null,
              updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          upsert: true,
        },
      }));

    if (ops.length === 0) {
      return res.status(400).json({ error: 'No valid check-ins in the array' });
    }

    const result = await db.collection('checkins').bulkWrite(ops, { ordered: false });

    res.json({
      upsertedCount: result.upsertedCount,
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    console.error('POST /checkins/bulk error:', err);
    res.status(500).json({ error: 'Failed to bulk upsert check-ins' });
  }
});

// ─── POST /checkins ───────────────────────────────────────────────────────────
// Creates a new check-in for the authenticated user (legacy endpoint).
// Body: { id, timestamp, phase, energy, focus, wellbeing, note? }
router.post('/', async (req, res) => {
  try {
    const db = getDB();
    const { id, timestamp, phase, energy, focus, wellbeing, note } = req.body;

    if (!phase || energy == null || focus == null || wellbeing == null) {
      return res.status(400).json({ error: 'Missing required fields: phase, energy, focus, wellbeing' });
    }

    const doc = {
      uid: req.user.uid,
      clientId: id || null,           // UUID from the iOS app
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      phase,
      energy: Number(energy),
      focus: Number(focus),
      wellbeing: Number(wellbeing),
      note: note || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('checkins').insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error('POST /checkins error:', err);
    res.status(500).json({ error: 'Failed to save check-in' });
  }
});

// ─── DELETE /checkins/by-client-id/:clientId ─────────────────────────────────
// Deletes a check-in by its iOS clientId (UUID string).
router.delete('/by-client-id/:clientId', async (req, res) => {
  try {
    const db = getDB();
    const result = await db.collection('checkins').deleteOne({
      clientId: req.params.clientId,
      uid: req.user.uid,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Check-in not found or not owned by you' });
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /checkins/by-client-id/:clientId error:', err);
    res.status(500).json({ error: 'Failed to delete check-in' });
  }
});

// ─── DELETE /checkins/:id ─────────────────────────────────────────────────────
// Deletes a specific check-in by Mongo _id (legacy, must belong to the authenticated user).
router.delete('/:id', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const db = getDB();
    const result = await db.collection('checkins').deleteOne({
      _id: new ObjectId(req.params.id),
      uid: req.user.uid,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Check-in not found or not owned by you' });
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /checkins/:id error:', err);
    res.status(500).json({ error: 'Failed to delete check-in' });
  }
});

module.exports = router;
