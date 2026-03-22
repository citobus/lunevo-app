const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { trackUsage } = require('../middleware/trackUsage');
const { getDB } = require('../db/mongo');

const router = express.Router();

router.use(requireAuth);
router.use(trackUsage('users'));

// ─── GET /users/me ────────────────────────────────────────────────────────────
// Returns the user profile for the authenticated user.
// Creates a minimal record if one doesn't exist yet (first login).
router.get('/me', async (req, res) => {
  try {
    const db = getDB();
    let profile = await db.collection('users').findOne({ uid: req.user.uid });

    if (!profile) {
      // Auto-create profile on first request
      profile = {
        uid: req.user.uid,
        email: req.user.email,
        firstName: '',
        lastName: '',
        onboardingComplete: false,
        totalCheckIns: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await db.collection('users').insertOne(profile);
    }

    res.json(profile);
  } catch (err) {
    console.error('GET /users/me error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─── PATCH /users/me ──────────────────────────────────────────────────────────
// Updates the user profile. Only the fields provided in the body are updated.
// Accepts any subset of UserProfile fields from the iOS app.
router.patch('/me', async (req, res) => {
  try {
    const db = getDB();

    // Strip fields that must not be overwritten via this endpoint
    const { uid, _id, createdAt, ...updates } = req.body;

    const result = await db.collection('users').findOneAndUpdate(
      { uid: req.user.uid },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: 'after', upsert: true }
    );

    res.json(result);
  } catch (err) {
    console.error('PATCH /users/me error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─── GET /users/me/saved-insights ─────────────────────────────────────────────
// Returns the user's saved insights, newest first.
router.get('/me/saved-insights', async (req, res) => {
  try {
    const db = getDB();
    const docs = await db.collection('saved_insights')
      .find({ uid: req.user.uid })
      .sort({ savedAt: -1 })
      .toArray();

    const insights = docs.map(({ uid, _id, ...rest }) => rest);
    res.json({ insights });
  } catch (err) {
    console.error('GET /users/me/saved-insights error:', err);
    res.status(500).json({ error: 'Failed to fetch saved insights' });
  }
});

// ─── PUT /users/me/saved-insights/:insightId ──────────────────────────────────
// Save (bookmark) an insight. Idempotent — re-saving the same insight is a no-op.
router.put('/me/saved-insights/:insightId', async (req, res) => {
  try {
    const db = getDB();
    const { insightId } = req.params;
    const { text, patternType, confidence, generatedAt, source } = req.body;

    await db.collection('saved_insights').updateOne(
      { uid: req.user.uid, insightId },
      {
        $setOnInsert: {
          uid: req.user.uid,
          insightId,
          text,
          patternType,
          confidence,
          generatedAt: generatedAt ? new Date(generatedAt) : new Date(),
          source: source || 'claude',
          savedAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /users/me/saved-insights error:', err);
    res.status(500).json({ error: 'Failed to save insight' });
  }
});

// ─── DELETE /users/me/saved-insights/:insightId ───────────────────────────────
// Unsave (un-bookmark) an insight.
router.delete('/me/saved-insights/:insightId', async (req, res) => {
  try {
    const db = getDB();
    await db.collection('saved_insights').deleteOne({
      uid: req.user.uid,
      insightId: req.params.insightId,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /users/me/saved-insights error:', err);
    res.status(500).json({ error: 'Failed to unsave insight' });
  }
});

module.exports = router;
