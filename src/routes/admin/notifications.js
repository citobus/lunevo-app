const express = require('express');
const { requireAdmin } = require('../../middleware/adminAuth');
const { getDB } = require('../../db/mongo');
const { sendToAllUsers, sendToUsers, logNotification } = require('../../services/fcm');

const router = express.Router();

router.use(requireAdmin);

// ─── POST /admin/notifications/send ──────────────────────────────────────────
// Send a push notification to all users (or a filtered set).
// Body: { title, body, targetUids?: string[] }
// If targetUids is provided, only those users receive the notification.
router.post('/send', async (req, res) => {
  try {
    const { title, body, targetUids } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Missing required fields: title, body' });
    }

    let result;
    if (Array.isArray(targetUids) && targetUids.length > 0) {
      result = await sendToUsers(targetUids, { title, body, data: { type: 'admin' } });
    } else {
      result = await sendToAllUsers({ title, body, data: { type: 'admin' } });
    }

    await logNotification({
      type: 'admin_manual',
      title,
      body,
      recipientCount: Array.isArray(targetUids) ? targetUids.length : 'all',
      sentCount: result.sent,
      failedCount: result.failed,
      triggeredBy: req.admin.email,
    });

    res.json({
      ok: true,
      sent: result.sent,
      failed: result.failed,
    });
  } catch (err) {
    console.error('POST /admin/notifications/send error:', err);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// ─── GET /admin/notifications/log ────────────────────────────────────────────
// Returns recent notification log entries for the admin dashboard.
router.get('/log', async (req, res) => {
  try {
    const db = getDB();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const logs = await db.collection('notification_log')
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    const entries = logs.map(l => ({
      id: l._id.toString(),
      type: l.type,
      title: l.title,
      body: l.body,
      recipientCount: l.recipientCount,
      sentCount: l.sentCount,
      failedCount: l.failedCount,
      triggeredBy: l.triggeredBy,
      createdAt: l.createdAt,
    }));

    res.json({ logs: entries });
  } catch (err) {
    console.error('GET /admin/notifications/log error:', err);
    res.status(500).json({ error: 'Failed to fetch notification log' });
  }
});

// ─── GET /admin/notifications/stats ──────────────────────────────────────────
// Returns basic stats about registered devices and notification-enabled users.
router.get('/stats', async (req, res) => {
  try {
    const db = getDB();

    const [totalDevices, totalUsers, disabledUsers] = await Promise.all([
      db.collection('device_tokens').countDocuments(),
      db.collection('users').countDocuments(),
      db.collection('users').countDocuments({ 'notificationSettings.isEnabled': false }),
    ]);

    res.json({
      totalDevices,
      totalUsers,
      notificationsEnabled: totalUsers - disabledUsers,
      notificationsDisabled: disabledUsers,
    });
  } catch (err) {
    console.error('GET /admin/notifications/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
