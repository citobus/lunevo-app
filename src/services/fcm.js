const admin = require('./firebase');
const { getDB } = require('../db/mongo');

/**
 * Send a push notification to a single user by uid.
 * Automatically filters out users with notifications disabled.
 * Returns { sent: number, failed: number }.
 */
async function sendToUser(uid, { title, body, data = {} }) {
  const db = getDB();

  // Check user notification preferences
  const user = await db.collection('users').findOne(
    { uid },
    { projection: { notificationSettings: 1 } }
  );
  if (user?.notificationSettings?.isEnabled === false) {
    return { sent: 0, failed: 0 };
  }

  // Get all active device tokens for this user
  const tokens = await db.collection('device_tokens')
    .find({ uid })
    .toArray();

  if (!tokens.length) return { sent: 0, failed: 0 };

  return sendToTokens(
    tokens.map(t => t.fcmToken),
    { title, body, data }
  );
}

/**
 * Send a push notification to multiple users by uid array.
 * Respects per-user notification preferences.
 */
async function sendToUsers(uids, { title, body, data = {} }) {
  const db = getDB();

  // Get all device tokens for these users (who have notifications enabled)
  const usersWithDisabled = await db.collection('users')
    .find(
      { uid: { $in: uids }, 'notificationSettings.isEnabled': false },
      { projection: { uid: 1 } }
    )
    .toArray();
  const disabledUids = new Set(usersWithDisabled.map(u => u.uid));
  const enabledUids = uids.filter(uid => !disabledUids.has(uid));

  if (!enabledUids.length) return { sent: 0, failed: 0 };

  const tokens = await db.collection('device_tokens')
    .find({ uid: { $in: enabledUids } })
    .toArray();

  if (!tokens.length) return { sent: 0, failed: 0 };

  return sendToTokens(
    tokens.map(t => t.fcmToken),
    { title, body, data }
  );
}

/**
 * Send a push notification to ALL users who have notifications enabled
 * and have a registered device token.
 */
async function sendToAllUsers({ title, body, data = {} }) {
  const db = getDB();

  // Get uids of users who have explicitly disabled notifications
  const disabledUsers = await db.collection('users')
    .find(
      { 'notificationSettings.isEnabled': false },
      { projection: { uid: 1 } }
    )
    .toArray();
  const disabledUids = new Set(disabledUsers.map(u => u.uid));

  // Get all device tokens, excluding disabled users
  const allTokens = await db.collection('device_tokens').find().toArray();
  const enabledTokens = allTokens.filter(t => !disabledUids.has(t.uid));

  if (!enabledTokens.length) return { sent: 0, failed: 0 };

  return sendToTokens(
    enabledTokens.map(t => t.fcmToken),
    { title, body, data }
  );
}

/**
 * Low-level: send to an array of FCM tokens.
 * Handles batching (FCM max 500 per call) and stale token cleanup.
 */
async function sendToTokens(fcmTokens, { title, body, data = {} }) {
  if (!fcmTokens.length) return { sent: 0, failed: 0 };

  const message = {
    notification: { title, body },
    data: data || {},
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    },
  };

  let sent = 0;
  let failed = 0;
  const staleTokens = [];

  // FCM sendEachForMulticast supports up to 500 tokens
  const batchSize = 500;
  for (let i = 0; i < fcmTokens.length; i += batchSize) {
    const batch = fcmTokens.slice(i, i + batchSize);

    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens: batch,
        ...message,
      });

      sent += response.successCount;
      failed += response.failureCount;

      // Collect stale tokens for cleanup
      response.responses.forEach((resp, idx) => {
        if (resp.error) {
          const code = resp.error.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            staleTokens.push(batch[idx]);
          }
        }
      });
    } catch (err) {
      console.error('FCM batch send error:', err.message);
      failed += batch.length;
    }
  }

  // Clean up stale tokens
  if (staleTokens.length) {
    try {
      const db = getDB();
      await db.collection('device_tokens').deleteMany({
        fcmToken: { $in: staleTokens },
      });
      console.log(`Cleaned up ${staleTokens.length} stale FCM tokens`);
    } catch (err) {
      console.error('Failed to clean up stale tokens:', err.message);
    }
  }

  return { sent, failed };
}

/**
 * Log a notification event for analytics/debugging.
 */
async function logNotification({ type, title, body, recipientCount, sentCount, failedCount, triggeredBy }) {
  try {
    const db = getDB();
    await db.collection('notification_log').insertOne({
      type,
      title,
      body,
      recipientCount,
      sentCount,
      failedCount,
      triggeredBy,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error('Failed to log notification:', err.message);
  }
}

module.exports = {
  sendToUser,
  sendToUsers,
  sendToAllUsers,
  sendToTokens,
  logNotification,
};
