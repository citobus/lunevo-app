const admin = require('../services/firebase');

/**
 * Express middleware that verifies a Firebase ID token sent in the
 * Authorization header as a Bearer token.
 *
 * On success it attaches `req.user` with:
 *   - uid        {string}  Firebase user ID
 *   - email      {string}  User email (if present)
 *   - name       {string}  Display name (if present)
 *   - firebase   {object}  Full decoded token
 *
 * The iOS app calls `AuthService.fetchIDToken()` and sends the result as:
 *   Authorization: Bearer <idToken>
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
      firebase: decoded,
    };

    next();
  } catch (err) {
    console.error('Token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };
