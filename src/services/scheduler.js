const crypto = require('crypto');
const cron = require('node-cron');
const { getDB } = require('../db/mongo');
const { sendToUser, logNotification } = require('./fcm');
const { generateInsightsForUser } = require('./insightGenerator');

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
// The check-in reminder scheduler runs every 30 minutes and evaluates each
// user individually using their stored timezone offset.
//
// ─── Insight Scheduler ──────────────────────────────────────────────────────
// Generates AI insights for eligible users twice a day at random times
// between (wakeTime + 1hr) and (bedtime - 1hr).  Runs every 15 minutes.

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

function getUserLocalDate(timezoneOffset) {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const localMs = utcMs + (timezoneOffset || 0) * 60000;
  return new Date(localMs);
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

// ─── Insight Scheduling ─────────────────────────────────────────────────────

/**
 * Deterministic per-user per-day random number generator.
 * Uses uid + date as seed so every cron tick computes the same slots.
 */
function seededRandom(uid, dateStr, slotIndex) {
  const hash = crypto.createHash('sha256')
    .update(`${uid}:${dateStr}:${slotIndex}`)
    .digest();
  // Use first 4 bytes as a uint32 → [0, 1) float
  return hash.readUInt32BE(0) / 0xFFFFFFFF;
}

/**
 * Compute the two insight generation slot times for a user on a given day.
 * Returns [slot1MinuteOfDay, slot2MinuteOfDay].
 */
function computeInsightSlots(uid, dateStr, sleepSchedule, localWeekday) {
  // Extract wake/bed times from the sleep schedule
  // sleepSchedule.entries is an array of { weekday, wakeTime, bedtime }
  // weekday: 1=Sun, 2=Mon, ... 7=Sat  (iOS Calendar.component(.weekday))
  let wakeMinutes = 8 * 60;  // default 8am
  let bedMinutes = 22 * 60;  // default 10pm

  if (sleepSchedule?.entries) {
    const entry = sleepSchedule.entries.find(e => e.weekday === localWeekday);
    if (entry) {
      if (entry.wakeTime) {
        const w = new Date(entry.wakeTime);
        if (!isNaN(w.getTime())) {
          wakeMinutes = w.getHours() * 60 + w.getMinutes();
        }
      }
      if (entry.bedtime) {
        const b = new Date(entry.bedtime);
        if (!isNaN(b.getTime())) {
          bedMinutes = b.getHours() * 60 + b.getMinutes();
        }
      }
    }
  }

  // Window: wakeTime + 1hr  to  bedtime - 1hr
  let earliest = wakeMinutes + 60;
  let latest = bedMinutes - 60;

  // Fallback if window too small (< 4 hours)
  if (latest - earliest < 240) {
    earliest = 8 * 60;
    latest = 21 * 60;
  }

  const midpoint = Math.floor((earliest + latest) / 2);

  // Slot 1: random in first half, Slot 2: random in second half
  const r1 = seededRandom(uid, dateStr, 0);
  const r2 = seededRandom(uid, dateStr, 1);

  const slot1 = earliest + Math.floor(r1 * (midpoint - earliest));
  const slot2 = midpoint + Math.floor(r2 * (latest - midpoint));

  return [slot1, slot2];
}

/**
 * Convert iOS weekday (1=Sun) to JS Date.getDay() (0=Sun) and back.
 * iOS Calendar.component(.weekday): 1=Sunday, 2=Monday, ...7=Saturday
 * JS Date.getDay(): 0=Sunday, 1=Monday, ...6=Saturday
 */
function jsWeekdayToIOS(jsDay) {
  return jsDay + 1; // 0→1, 1→2, ...6→7
}

async function processScheduledInsights() {
  try {
    const db = getDB();

    // Find eligible users: onboarding complete, have device tokens
    const users = await db.collection('users').find({
      onboardingComplete: true,
    }).toArray();

    if (!users.length) return;

    // Get timezone info from device tokens
    const uids = users.map(u => u.uid);
    const deviceTokens = await db.collection('device_tokens')
      .find({ uid: { $in: uids } })
      .toArray();

    const tzByUid = {};
    const uidsWithTokens = new Set();
    for (const dt of deviceTokens) {
      uidsWithTokens.add(dt.uid);
      if (dt.timezoneOffset != null) {
        tzByUid[dt.uid] = dt.timezoneOffset;
      }
    }

    let generatedCount = 0;

    for (const user of users) {
      // Skip users without device tokens
      if (!uidsWithTokens.has(user.uid)) continue;

      // Respect notification preferences
      const freq = user.notificationSettings?.insightsFrequency;
      if (freq === 'never') continue;

      const tz = tzByUid[user.uid] ?? 0;
      const localDate = getUserLocalDate(tz);
      const localHour = localDate.getHours();

      // Quiet hours
      if (isQuietHour(localHour)) continue;

      const localDateStr = localDate.toISOString().slice(0, 10);
      const localWeekday = jsWeekdayToIOS(localDate.getDay());
      const localMinuteOfDay = localDate.getHours() * 60 + localDate.getMinutes();

      // Compute today's slots
      const [slot1, slot2] = computeInsightSlots(
        user.uid, localDateStr, user.sleepSchedule, localWeekday
      );

      // Check how many insights we've already generated today for this user
      const todayStart = new Date(localDate);
      todayStart.setHours(0, 0, 0, 0);
      // Convert local todayStart back to UTC for querying
      const todayStartUTC = new Date(todayStart.getTime() - tz * 60000);

      const todayInsightCount = await db.collection('ai_insights').countDocuments({
        uid: user.uid,
        source: 'cron',
        generatedAt: { $gte: todayStartUTC },
      });

      // For "infrequent": max 1 per day
      const maxPerDay = freq === 'infrequent' ? 1 : 2;
      if (todayInsightCount >= maxPerDay) continue;

      // Check if we've passed the next eligible slot
      let shouldGenerate = false;
      if (todayInsightCount === 0 && localMinuteOfDay >= slot1) {
        shouldGenerate = true;
      } else if (todayInsightCount === 1 && localMinuteOfDay >= slot2 && maxPerDay >= 2) {
        shouldGenerate = true;
      }

      if (!shouldGenerate) continue;

      // Generate insights for this user
      try {
        const success = await generateInsightsForUser(user.uid);
        if (success) {
          generatedCount++;
          console.log(`[Scheduler] Generated insights for user ${user.uid.substring(0, 8)}…`);
        }
      } catch (err) {
        console.error(`[Scheduler] Insight generation failed for ${user.uid.substring(0, 8)}…:`, err.message);
      }
    }

    if (generatedCount > 0) {
      console.log(`[Scheduler] Generated insights for ${generatedCount} users`);
    }
  } catch (err) {
    console.error('[Scheduler] Insight scheduling error:', err);
  }
}

function startScheduler() {
  // Check-in reminders: every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    processCheckInReminders();
  });

  // Insight generation: every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    processScheduledInsights();
  });

  console.log('Notification scheduler started (reminders every 30 min, insights every 15 min)');
}

module.exports = { startScheduler, processCheckInReminders, processScheduledInsights };
