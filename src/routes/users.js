const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDB } = require('../db/mongo');

const router = express.Router();

router.use(requireAuth);

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

module.exports = router;
