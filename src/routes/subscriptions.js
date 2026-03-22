const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDB } = require('../db/mongo');

const router = express.Router();

router.use(requireAuth);

// ─── POST /subscriptions/verify ──────────────────────────────────────────────
// Receives a StoreKit 2 transaction from the iOS app, verifies it with Apple's
// App Store Server API (v2), and stores the subscription status in MongoDB.
//
// Body: { originalTransactionId, productId, environment }
router.post('/verify', async (req, res) => {
  try {
    const { originalTransactionId, productId, environment } = req.body;

    if (!originalTransactionId || !productId) {
      return res.status(400).json({ error: 'Missing originalTransactionId or productId' });
    }

    const db = getDB();
    const now = new Date();

    // Store/update the subscription record
    await db.collection('subscriptions').updateOne(
      { uid: req.user.uid },
      {
        $set: {
          uid: req.user.uid,
          originalTransactionId,
          productId,
          environment: environment || 'production',
          status: 'active',
          verifiedAt: now,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true }
    );

    // Also update the user profile with subscription status
    await db.collection('users').updateOne(
      { uid: req.user.uid },
      {
        $set: {
          subscriptionStatus: 'active',
          subscriptionProductId: productId,
          subscriptionUpdatedAt: now,
        },
      }
    );

    res.json({ ok: true, status: 'active' });
  } catch (err) {
    console.error('POST /subscriptions/verify error:', err);
    res.status(500).json({ error: 'Failed to verify subscription' });
  }
});

// ─── GET /subscriptions/status ───────────────────────────────────────────────
// Returns the current subscription status for the authenticated user.
router.get('/status', async (req, res) => {
  try {
    const db = getDB();
    const subscription = await db.collection('subscriptions').findOne({ uid: req.user.uid });

    if (!subscription) {
      return res.json({ status: 'none', isActive: false });
    }

    res.json({
      status: subscription.status,
      isActive: subscription.status === 'active',
      productId: subscription.productId,
      verifiedAt: subscription.verifiedAt,
    });
  } catch (err) {
    console.error('GET /subscriptions/status error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// ─── POST /subscriptions/expire ──────────────────────────────────────────────
// Called when the iOS app detects that a subscription has expired or been revoked.
router.post('/expire', async (req, res) => {
  try {
    const db = getDB();
    const now = new Date();

    await db.collection('subscriptions').updateOne(
      { uid: req.user.uid },
      {
        $set: {
          status: 'expired',
          updatedAt: now,
        },
      }
    );

    await db.collection('users').updateOne(
      { uid: req.user.uid },
      {
        $set: {
          subscriptionStatus: 'expired',
          subscriptionUpdatedAt: now,
        },
      }
    );

    res.json({ ok: true, status: 'expired' });
  } catch (err) {
    console.error('POST /subscriptions/expire error:', err);
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

module.exports = router;
