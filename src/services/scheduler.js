const cron = require('node-cron');
const { getDB } = require('../db/mongo');
const { sendToUser, logNotification } = require('./fcm');

// ─── Notification Scheduler ──────────────────────────────────────────────────
// Sends check-in reminders based on each user's notification preferences.
//
// Strategy (non-overbearing):
//   "often"      → up to 2 reminders/day (9am, 6pm user-local time)
//                   only if no check-in in the last 5 hours
//   "infrequent" → 1 reminder/day (12pm user-local time)
//                   only if no check-in today
//   "never"      → no reminders
//
// Quiet hours: 10pm – 8am (user-local time) — no notifications sent.
// Daily cap: max 3 notifications per user per day (across all types).
//
// The scheduler runs every 30 minutes and evaluates each user individually
// using their stored timezone offset.

const REMINDER_MESSAGES = [
  { title: 'How are you feeling?', body: 'Take a moment to check in with your energy, focus, and wellbeing.' },
  { title: 'Time for a quick check-in', body: "A few seconds now helps you spot patterns later." },
  { title: 'Your rhythm matters', body: "Log how you're doing right now — your future self will thank you." },
  { title: "Don't forget to check in", body: 'Tracking consistently helps lunevo give you better insights.' },
];

function randomReminder() {
  return REMINDER_MESSAGES[Math.floor(Math.random() * REMINDER_MESSAGES.length)];
}

/**
 * Get the current hour (0-23) in the user's local timezone.
 * timezoneOffset is minutes ahead of UTC (e.g. UTC-5 = -300, UTC+2 = 120).
 */
function getUserLocalHour(timezoneOffset) {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const localMs = utcMs + (timezoneOffset || 0) * 60000;
  return new Date(localMs).getHours();
}

function isQuietHour(localHour) {
  return localHour >= 22 || localHour < 8;
}

/**
 * Check how many notifications this user has received today.
 */
async function getUserDailyNotificationCount(db, uid) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  return db.collection('notification_log').countDocuments({
    type: { $in: ['checkin_reminder', 'insight_available'] },
    recipientUid: uid,
    createdAt: { $gte: todayStart },
  });
}

/**
 * Check when the user's most recent check-in was.
 */
async function getLastCheckInTime(db, uid) {
  const latest = await db.collection('checkins')
    .findOne({ uid }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } });
  return latest?.timestamp || null;
}

const DAILY_CAP = 3;
const OFTEN_HOURS = [9, 18];        // 9am and 6pm local
const INFREQUENT_HOURS = [12];       // 12pm local
const OFTEN_COOLDOWN_MS = 5 * 60 * 60 * 1000;  // 5 hours

async function processCheckInReminders() {
  try {
    const db = getDB();

    // Get all users with notifications enabled and check-in reminders not set to "never"
    const users = await db.collection('users').find({
      'notificationSettings.isEnabled': true,
      'notificationSettings.checkInReminderFrequency': { $ne: 'never' },
    }).toArray();

    if (!users.length) return;

    // Get device tokens grouped by uid for timezone info
    const uids = users.map(u => u.uid);
    const deviceTokens = await db.collection('device_tokens')
      .find({ uid: { $in: uids } })
      .toArray();

    // Build timezone lookup (use the most recent device's timezone)
    const tzByUid = {};
    for (const dt of deviceTokens) {
      if (dt.timezoneOffset != null) {
        tzByUid[dt.uid] = dt.timezoneOffset;
      }
    }

    // Also build a set of uids that actually have device tokens
    const uidsWithTokens = new Set(deviceTokens.map(dt => dt.uid));

    let sentCount = 0;

    for (const user of users) {
      if (!uidsWithTokens.has(user.uid)) continue;

      const tz = tzByUid[user.uid] ?? 0;
      const localHour = getUserLocalHour(tz);

      // Quiet hours check
      if (isQuietHour(localHour)) continue;

      const freq = user.notificationSettings?.checkInReminderFrequency;
      const targetHours = freq === 'often' ? OFTEN_HOURS : INFREQUENT_HOURS;

      // Only send if we're within 30 minutes of a target hour
      // (since the cron runs every 30 min)
      const isTargetWindow = targetHours.some(h => localHour === h);
      if (!isTargetWindow) continue;

      // Daily cap
      const dailyCount = await getUserDailyNotificationCount(db, user.uid);
      if (dailyCount >= DAILY_CAP) continue;

      // Cooldown: don't send if user checked in recently
      const lastCheckIn = await getLastCheckInTime(db, user.uid);
      if (freq === 'often' && lastCheckIn) {
        const elapsed = Date.now() - new Date(lastCheckIn).getTime();
        if (elapsed < OFTEN_COOLDOWN_MS) continue;
      }
      if (freq === 'infrequent' && lastCheckIn) {
        // For infrequent: only send if no check-in today
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        if (new Date(lastCheckIn) >= todayStart) continue;
      }

      const reminder = randomReminder();
      const result = await sendToUser(user.uid, {
        title: reminder.title,
        body: reminder.body,
        data: { type: 'checkin_reminder' },
      });

      if (result.sent > 0) {
        sentCount++;
        // Log per-user for daily cap tracking
        await db.collection('notification_log').insertOne({
          type: 'checkin_reminder',
          title: reminder.title,
          body: reminder.body,
          recipientUid: user.uid,
          sentCount: result.sent,
          failedCount: result.failed,
          triggeredBy: 'scheduler',
          createdAt: new Date(),
        });
      }
    }

    if (sentCount > 0) {
      console.log(`[Scheduler] Sent check-in reminders to ${sentCount} users`);
    }
  } catch (err) {
    console.error('[Scheduler] Check-in reminder error:', err);
  }
}

function startScheduler() {
  // Run every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    processCheckInReminders();
  });

  console.log('Notification scheduler started (every 30 min)');
}

module.exports = { startScheduler, processCheckInReminders };
