const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDB } = require('../db/mongo');

const router = express.Router();

router.use(requireAuth);

// ─── PUT /devices/token ──────────────────────────────────────────────────────
// Register or update an FCM device token for the authenticated user.
// Idempotent: safe to call on every app launch.
// Body: { fcmToken: string, platform?: string, timezoneOffset?: number }
router.put('/token', async (req, res) => {
  try {
    const { fcmToken, platform, timezoneOffset } = req.body;

    if (!fcmToken || typeof fcmToken !== 'string') {
      return res.status(400).json({ error: 'Missing required field: fcmToken' });
    }

    const db = getDB();

    // Upsert by (uid, fcmToken) — one user can have multiple devices
    await db.collection('device_tokens').updateOne(
      { uid: req.user.uid, fcmToken },
      {
        $set: {
          uid: req.user.uid,
          fcmToken,
          platform: platform || 'ios',
          timezoneOffset: typeof timezoneOffset === 'number' ? timezoneOffset : null,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /devices/token error:', err);
    res.status(500).json({ error: 'Failed to register device token' });
  }
});

// ─── DELETE /devices/token ───────────────────────────────────────────────────
// Unregister an FCM device token (e.g. on sign-out).
// Body: { fcmToken: string }
router.delete('/token', async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken || typeof fcmToken !== 'string') {
      return res.status(400).json({ error: 'Missing required field: fcmToken' });
    }

    const db = getDB();
    await db.collection('device_tokens').deleteOne({
      uid: req.user.uid,
      fcmToken,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /devices/token error:', err);
    res.status(500).json({ error: 'Failed to unregister device token' });
  }
});

module.exports = router;
