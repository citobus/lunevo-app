const { getDB } = require('../db/mongo');

/**
 * Express middleware that checks if the authenticated user has an active subscription.
 * Must be used AFTER requireAuth (needs req.user.uid).
 *
 * Returns 403 with { error: 'subscription_required' } if no active subscription found.
 * Passes through if the user has an active subscription or if the route is exempt.
 */
async function requireSubscription(req, res, next) {
  try {
    const db = getDB();
    const subscription = await db.collection('subscriptions').findOne({
      uid: req.user.uid,
      status: 'active',
    });

    if (!subscription) {
      return res.status(403).json({ error: 'subscription_required' });
    }

    req.subscription = subscription;
    next();
  } catch (err) {
    console.error('Subscription check failed:', err.message);
    // Fail open — don't block the user if the DB query fails
    next();
  }
}

module.exports = { requireSubscription };
