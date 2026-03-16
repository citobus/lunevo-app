/**
 * Per-user rate limiting middleware using an in-memory sliding window.
 * Works well for single-instance deployments (Railway).
 *
 * Usage:
 *   const { rateLimit } = require('../middleware/rateLimit');
 *   router.post('/guidance', rateLimit({ windowMs: 60_000, max: 30 }), handler);
 */

// Map<string, number[]>  — key is `uid:routeKey`, value is array of timestamps
const hits = new Map();

// Garbage-collect expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of hits) {
    const fresh = timestamps.filter((t) => now - t < 3_600_000); // keep up to 1 hr
    if (fresh.length === 0) hits.delete(key);
    else hits.set(key, fresh);
  }
}, 5 * 60 * 1000).unref();

/**
 * @param {object}  opts
 * @param {number}  opts.windowMs  – sliding window in milliseconds (default 3600000 = 1 hr)
 * @param {number}  opts.max       – max requests per window (default 30)
 * @param {string} [opts.key]      – optional route key to namespace limits (default: req.baseUrl + req.path)
 */
function rateLimit({ windowMs = 3_600_000, max = 30, key: routeKey } = {}) {
  return (req, res, next) => {
    if (!req.user?.uid) {
      // requireAuth must run first; if uid is missing just pass through
      return next();
    }

    const bucketKey = `${req.user.uid}:${routeKey || req.baseUrl + req.path}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = hits.get(bucketKey) || [];
    timestamps = timestamps.filter((t) => t > windowStart);

    if (timestamps.length >= max) {
      const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
        retryAfter,
      });
    }

    timestamps.push(now);
    hits.set(bucketKey, timestamps);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', max - timestamps.length);

    next();
  };
}

module.exports = { rateLimit };
