const admin = require('../services/firebase');

/**
 * Express middleware that verifies the request is from an authenticated admin user.
 *
 * Requires:
 *   1. A valid Firebase ID token in the Authorization: Bearer header.
 *   2. The decoded token must include a verified email address.
 *   3. That email must be in the ADMIN_EMAILS env var
 *      (comma-separated list, e.g. "you@example.com,partner@example.com").
 *
 * On success attaches `req.admin = { uid, email, name }`.
 */
async function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    console.error('Admin token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const email = decoded.email;
  if (!email || decoded.email_verified !== true) {
    return res.status(403).json({ error: 'Admin access requires a verified email address' });
  }

  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.includes(email.toLowerCase())) {
    console.warn(`Blocked non-admin access attempt from: ${email}`);
    return res.status(403).json({ error: 'Forbidden: admin access required' });
  }

  req.admin = {
    uid: decoded.uid,
    email,
    name: decoded.name || null,
  };

  next();
}

module.exports = { requireAdmin };
