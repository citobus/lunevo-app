const { getDB } = require('../db/mongo');

function trackUsage(resource) {
  const normalizedResource = sanitizeFieldToken(resource || 'unknown');

  return (req, res, next) => {
    if (!req.user?.uid) {
      next();
      return;
    }

    const startedAt = Date.now();
    const createdAt = new Date();

    res.on('finish', () => {
      if (!req.user?.uid) return;

      let db;
      try {
        db = getDB();
      } catch (err) {
        return;
      }

      const usageDoc = {
        uid: req.user.uid,
        email: req.user.email || null,
        method: req.method,
        route: normalizeRoute(req),
        resource: normalizedResource,
        statusCode: res.statusCode,
        durationMs: Math.max(Date.now() - startedAt, 0),
        userAgent: truncate(req.get('user-agent'), 255),
        createdAt,
      };

      const profileUpdate = {
        $set: {
          email: req.user.email || null,
          lastApiActivityAt: createdAt,
        },
        $inc: {
          'usageStats.trackedRequests': 1,
          [`usageStats.byResource.${normalizedResource}`]: 1,
        },
        $setOnInsert: {
          uid: req.user.uid,
          firstName: '',
          lastName: '',
          onboardingComplete: false,
          totalCheckIns: 0,
          accountDisabled: false,
          createdAt,
          updatedAt: createdAt,
        },
      };

      Promise.allSettled([
        db.collection('api_usage_events').insertOne(usageDoc),
        db.collection('users').updateOne({ uid: req.user.uid }, profileUpdate, { upsert: true }),
      ]).then(results => {
        results.forEach(result => {
          if (result.status === 'rejected') {
            console.error('Failed to persist API usage tracking:', result.reason?.message || result.reason);
          }
        });
      });
    });

    next();
  };
}

function normalizeRoute(req) {
  const baseUrl = req.baseUrl || '';
  const routePath = Array.isArray(req.route?.path)
    ? req.route.path[0]
    : (req.route?.path || req.path || '');

  return normalizeSlashes(`${baseUrl}${routePath}`);
}

function normalizeSlashes(value) {
  const collapsed = String(value || '').replace(/\/+/g, '/');
  if (!collapsed) return '/';
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

function truncate(value, maxLength) {
  if (typeof value !== 'string') return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function sanitizeFieldToken(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

module.exports = { trackUsage };
