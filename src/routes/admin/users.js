const express = require('express');
const admin = require('../../services/firebase');
const { requireAdmin } = require('../../middleware/adminAuth');
const { getDB } = require('../../db/mongo');

const router = express.Router();

const ALLOWED_GENDERS = new Set(['male', 'female', 'other']);
const ALLOWED_NOTIFICATION_FREQUENCIES = new Set(['often', 'infrequent', 'never']);
const REQUEST_TRACKING_NOTE = 'Tracked API request logs start after this backend version is deployed.';
const DEFAULT_NOTIFICATION_SETTINGS = {
  isEnabled: true,
  checkInReminderFrequency: 'often',
  insightsFrequency: 'infrequent',
};

router.use(requireAdmin);

// ─── GET /admin/users/stats ─────────────────────────────────────────────────
// Returns rollup metrics for the admin user-management dashboard.
router.get('/stats', async (req, res) => {
  try {
    const db = getDB();
    const since7d = daysAgo(7);
    const since30d = daysAgo(30);

    const [
      totalUsers,
      notificationsDisabled,
      activeSubscriptions,
      expiredSubscriptions,
      accountsCreated7d,
      activeInLast7d,
      totalApiCalls7d,
      totalApiCalls30d,
    ] = await Promise.all([
      db.collection('users').countDocuments(),
      db.collection('users').countDocuments({ 'notificationSettings.isEnabled': false }),
      db.collection('subscriptions').countDocuments({ status: 'active' }),
      db.collection('subscriptions').countDocuments({ status: 'expired' }),
      db.collection('users').countDocuments({ createdAt: { $gte: since7d } }),
      db.collection('users').countDocuments({ lastApiActivityAt: { $gte: since7d } }),
      db.collection('api_usage_events').countDocuments({ createdAt: { $gte: since7d } }),
      db.collection('api_usage_events').countDocuments({ createdAt: { $gte: since30d } }),
    ]);

    res.json({
      totalUsers,
      activeSubscriptions,
      expiredSubscriptions,
      noSubscription: Math.max(totalUsers - activeSubscriptions - expiredSubscriptions, 0),
      notificationsEnabled: totalUsers - notificationsDisabled,
      notificationsDisabled,
      activeInLast7d,
      accountsCreated7d,
      totalApiCalls7d,
      totalApiCalls30d,
      requestTrackingNote: REQUEST_TRACKING_NOTE,
    });
  } catch (err) {
    console.error('GET /admin/users/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

// ─── GET /admin/users ───────────────────────────────────────────────────────
// Returns a searchable list of users with account and usage summaries.
router.get('/', async (req, res) => {
  try {
    const db = getDB();
    const limit = clampInt(req.query.limit, 50, 1, 100);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const subscriptionStatus = typeof req.query.subscriptionStatus === 'string'
      ? req.query.subscriptionStatus.trim().toLowerCase()
      : 'all';

    if (!['all', 'active', 'expired', 'none'].includes(subscriptionStatus)) {
      return res.status(400).json({ error: 'subscriptionStatus must be one of: all, active, expired, none' });
    }

    const users = await db.collection('users')
      .find(buildUserSearchFilter(search))
      .sort({ lastApiActivityAt: -1, createdAt: -1 })
      .limit(250)
      .toArray();

    const metrics = await loadListMetrics(db, users.map(user => user.uid));
    let items = users.map(user => formatListUser(user, metrics));

    if (subscriptionStatus !== 'all') {
      items = items.filter(user => user.subscription.status === subscriptionStatus);
    }

    items.sort(sortUsersForAdmin);

    res.json({
      users: items.slice(0, limit),
      totalMatched: items.length,
      requestTrackingNote: REQUEST_TRACKING_NOTE,
    });
  } catch (err) {
    console.error('GET /admin/users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── GET /admin/users/:uid ──────────────────────────────────────────────────
// Returns a single user's account details, devices, and tracked API activity.
router.get('/:uid', async (req, res) => {
  try {
    const db = getDB();
    const detail = await loadAdminUserDetail(db, req.params.uid);

    if (!detail) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: detail, requestTrackingNote: REQUEST_TRACKING_NOTE });
  } catch (err) {
    console.error('GET /admin/users/:uid error:', err);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// ─── PATCH /admin/users/:uid ────────────────────────────────────────────────
// Updates editable account fields, notification preferences, and subscription state.
router.patch('/:uid', async (req, res) => {
  try {
    const db = getDB();
    const uid = String(req.params.uid || '').trim();

    if (!uid) {
      return res.status(400).json({ error: 'User id is required' });
    }

    const [existingUser, existingSubscription, authUser] = await Promise.all([
      db.collection('users').findOne({ uid }),
      db.collection('subscriptions').findOne({ uid }),
      getAuthUser(uid),
    ]);

    if (!existingUser && !authUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const {
      firstName,
      lastName,
      gender,
      dateOfBirth,
      onboardingComplete,
      notificationSettings,
      subscriptionStatus,
      subscriptionProductId,
      accountDisabled,
    } = req.body || {};

    const now = new Date();
    const userSet = {};
    const userUnset = {};

    if (firstName !== undefined) {
      if (typeof firstName !== 'string') {
        return res.status(400).json({ error: 'firstName must be a string' });
      }
      userSet.firstName = firstName.trim();
    }

    if (lastName !== undefined) {
      if (typeof lastName !== 'string') {
        return res.status(400).json({ error: 'lastName must be a string' });
      }
      userSet.lastName = lastName.trim();
    }

    if (gender !== undefined) {
      userSet.gender = normalizeGender(gender);
      if (gender !== null && gender !== '' && !userSet.gender) {
        return res.status(400).json({ error: 'gender must be one of: male, female, other, or empty' });
      }
    }

    if (dateOfBirth !== undefined) {
      const parsedDateOfBirth = parseNullableDate(dateOfBirth);
      if (dateOfBirth !== null && dateOfBirth !== '' && !parsedDateOfBirth) {
        return res.status(400).json({ error: 'dateOfBirth must be a valid ISO date or empty' });
      }
      userSet.dateOfBirth = parsedDateOfBirth;
    }

    if (onboardingComplete !== undefined) {
      if (typeof onboardingComplete !== 'boolean') {
        return res.status(400).json({ error: 'onboardingComplete must be a boolean' });
      }
      userSet.onboardingComplete = onboardingComplete;
    }

    if (notificationSettings !== undefined) {
      if (!notificationSettings || typeof notificationSettings !== 'object' || Array.isArray(notificationSettings)) {
        return res.status(400).json({ error: 'notificationSettings must be an object' });
      }

      const currentNotificationSettings = normalizeNotificationSettings(existingUser?.notificationSettings);
      const nextNotificationSettings = {
        ...currentNotificationSettings,
        ...notificationSettings,
      };

      if (typeof nextNotificationSettings.isEnabled !== 'boolean') {
        return res.status(400).json({ error: 'notificationSettings.isEnabled must be a boolean' });
      }

      nextNotificationSettings.checkInReminderFrequency = normalizeNotificationFrequency(
        nextNotificationSettings.checkInReminderFrequency
      );
      nextNotificationSettings.insightsFrequency = normalizeNotificationFrequency(
        nextNotificationSettings.insightsFrequency
      );

      if (!nextNotificationSettings.checkInReminderFrequency || !nextNotificationSettings.insightsFrequency) {
        return res.status(400).json({ error: 'notificationSettings frequencies must be often, infrequent, or never' });
      }

      userSet.notificationSettings = nextNotificationSettings;
    }

    let resolvedSubscriptionStatus;
    let resolvedSubscriptionProductId;
    if (subscriptionStatus !== undefined || subscriptionProductId !== undefined) {
      resolvedSubscriptionStatus = normalizeSubscriptionStatus(
        subscriptionStatus !== undefined
          ? subscriptionStatus
          : (existingSubscription?.status || existingUser?.subscriptionStatus || 'none')
      );

      if (!resolvedSubscriptionStatus) {
        return res.status(400).json({ error: 'subscriptionStatus must be one of: active, expired, none' });
      }

      if (subscriptionProductId !== undefined && subscriptionProductId !== null && typeof subscriptionProductId !== 'string') {
        return res.status(400).json({ error: 'subscriptionProductId must be a string or null' });
      }

      resolvedSubscriptionProductId = subscriptionProductId === undefined
        ? (existingSubscription?.productId || existingUser?.subscriptionProductId || null)
        : (typeof subscriptionProductId === 'string' && subscriptionProductId.trim()
          ? subscriptionProductId.trim()
          : null);

      userSet.subscriptionStatus = resolvedSubscriptionStatus;
      userSet.subscriptionProductId = resolvedSubscriptionStatus === 'none' ? null : resolvedSubscriptionProductId;
      userSet.subscriptionUpdatedAt = now;
    }

    if (accountDisabled !== undefined) {
      if (typeof accountDisabled !== 'boolean') {
        return res.status(400).json({ error: 'accountDisabled must be a boolean' });
      }
      if (accountDisabled && req.admin.uid === uid) {
        return res.status(400).json({ error: 'You cannot disable your own admin account' });
      }
      userSet.accountDisabled = accountDisabled;
    }

    if (
      Object.keys(userSet).length === 0 &&
      Object.keys(userUnset).length === 0 &&
      accountDisabled === undefined &&
      resolvedSubscriptionStatus === undefined
    ) {
      return res.status(400).json({ error: 'No supported fields were provided' });
    }

    userSet.updatedAt = now;
    if (authUser?.email || existingUser?.email) {
      userSet.email = authUser?.email || existingUser?.email || null;
    }

    const writes = [
      db.collection('users').updateOne(
        { uid },
        {
          $set: userSet,
          ...(Object.keys(userUnset).length ? { $unset: userUnset } : {}),
          $setOnInsert: {
            uid,
            createdAt: now,
          },
        },
        { upsert: true }
      ),
    ];

    if (resolvedSubscriptionStatus !== undefined) {
      if (resolvedSubscriptionStatus === 'none') {
        writes.push(db.collection('subscriptions').deleteOne({ uid }));
      } else {
        writes.push(
          db.collection('subscriptions').updateOne(
            { uid },
            {
              $set: {
                uid,
                status: resolvedSubscriptionStatus,
                productId: resolvedSubscriptionProductId,
                environment: existingSubscription?.environment || 'production',
                updatedAt: now,
                ...(resolvedSubscriptionStatus === 'active' ? { verifiedAt: now } : {}),
              },
              $setOnInsert: {
                createdAt: now,
              },
            },
            { upsert: true }
          )
        );
      }
    }

    if (accountDisabled !== undefined && authUser) {
      writes.push(admin.auth().updateUser(uid, { disabled: accountDisabled }));
    }

    await Promise.all(writes);

    const detail = await loadAdminUserDetail(db, uid);
    res.json({ ok: true, user: detail });
  } catch (err) {
    console.error('PATCH /admin/users/:uid error:', err);
    res.status(500).json({ error: 'Failed to update user account' });
  }
});

// ─── DELETE /admin/users/:uid ───────────────────────────────────────────────
// Permanently deletes the user's Firebase account and associated MongoDB data.
router.delete('/:uid', async (req, res) => {
  try {
    const db = getDB();
    const uid = String(req.params.uid || '').trim();

    if (!uid) {
      return res.status(400).json({ error: 'User id is required' });
    }

    if (req.admin.uid === uid) {
      return res.status(400).json({ error: 'You cannot delete your own admin account' });
    }

    const [existingUser, authUser] = await Promise.all([
      db.collection('users').findOne({ uid }, { projection: { _id: 1 } }),
      getAuthUser(uid),
    ]);

    if (!existingUser && !authUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const deletionTasks = [
      ['users', db.collection('users').deleteOne({ uid })],
      ['checkins', db.collection('checkins').deleteMany({ uid })],
      ['ai_guidance', db.collection('ai_guidance').deleteMany({ uid })],
      ['ai_insights', db.collection('ai_insights').deleteMany({ uid })],
      ['saved_insights', db.collection('saved_insights').deleteMany({ uid })],
      ['subscriptions', db.collection('subscriptions').deleteMany({ uid })],
      ['device_tokens', db.collection('device_tokens').deleteMany({ uid })],
      ['message_reads', db.collection('message_reads').deleteMany({ uid })],
      ['notification_log', db.collection('notification_log').deleteMany({ recipientUid: uid })],
      ['api_usage_events', db.collection('api_usage_events').deleteMany({ uid })],
    ];

    const settledDeletions = await Promise.allSettled(deletionTasks.map(([, task]) => task));
    const deletionSummary = {};
    const errors = [];

    settledDeletions.forEach((result, index) => {
      const key = deletionTasks[index][0];
      if (result.status === 'fulfilled') {
        deletionSummary[key] = getDeleteCount(result.value);
      } else {
        deletionSummary[key] = null;
        errors.push(`${key}: ${result.reason?.message || result.reason}`);
      }
    });

    try {
      if (authUser) {
        await admin.auth().deleteUser(uid);
      }
    } catch (err) {
      if (!isAuthUserNotFound(err)) {
        errors.push(`firebase_auth: ${err.message}`);
      }
    }

    if (errors.length) {
      return res.status(500).json({
        error: 'User deletion was only partially completed',
        deleted: deletionSummary,
        details: errors,
      });
    }

    res.json({ ok: true, deleted: deletionSummary });
  } catch (err) {
    console.error('DELETE /admin/users/:uid error:', err);
    res.status(500).json({ error: 'Failed to delete user account' });
  }
});

async function loadListMetrics(db, uids) {
  if (!uids.length) {
    return {
      subscriptionsByUid: new Map(),
      devicesByUid: new Map(),
      checkinsByUid: new Map(),
      insightsByUid: new Map(),
      usageByUid: new Map(),
    };
  }

  const since7d = daysAgo(7);
  const since30d = daysAgo(30);

  const [
    subscriptions,
    devices,
    checkins,
    insights,
    usage,
  ] = await Promise.all([
    db.collection('subscriptions')
      .find({ uid: { $in: uids } }, { projection: { uid: 1, status: 1, productId: 1, updatedAt: 1 } })
      .toArray(),
    db.collection('device_tokens')
      .aggregate([
        { $match: { uid: { $in: uids } } },
        { $group: { _id: '$uid', deviceCount: { $sum: 1 } } },
      ])
      .toArray(),
    db.collection('checkins')
      .aggregate([
        { $match: { uid: { $in: uids } } },
        { $group: { _id: '$uid', totalCheckIns: { $sum: 1 }, lastCheckInAt: { $max: '$timestamp' } } },
      ])
      .toArray(),
    db.collection('ai_insights')
      .aggregate([
        {
          $match: { uid: { $in: uids } },
        },
        {
          $project: {
            uid: 1,
            generatedAt: 1,
            insightCount: { $size: { $ifNull: ['$insights', []] } },
          },
        },
        {
          $group: {
            _id: '$uid',
            totalInsights: { $sum: '$insightCount' },
            lastInsightAt: { $max: '$generatedAt' },
          },
        },
      ])
      .toArray(),
    db.collection('api_usage_events')
      .aggregate([
        {
          $match: {
            uid: { $in: uids },
            createdAt: { $gte: since30d },
          },
        },
        {
          $group: {
            _id: '$uid',
            requests30d: { $sum: 1 },
            requests7d: {
              $sum: {
                $cond: [
                  { $gte: ['$createdAt', since7d] },
                  1,
                  0,
                ],
              },
            },
            lastTrackedRequestAt: { $max: '$createdAt' },
          },
        },
      ])
      .toArray(),
  ]);

  return {
    subscriptionsByUid: mapBy(subscriptions, 'uid'),
    devicesByUid: mapBy(devices, '_id'),
    checkinsByUid: mapBy(checkins, '_id'),
    insightsByUid: mapBy(insights, '_id'),
    usageByUid: mapBy(usage, '_id'),
  };
}

function formatListUser(user, metrics) {
  const subscription = metrics.subscriptionsByUid.get(user.uid);
  const checkins = metrics.checkinsByUid.get(user.uid);
  const insights = metrics.insightsByUid.get(user.uid);
  const usage = metrics.usageByUid.get(user.uid);
  const devices = metrics.devicesByUid.get(user.uid);

  return {
    uid: user.uid,
    email: user.email || null,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    displayName: buildDisplayName(user),
    onboardingComplete: Boolean(user.onboardingComplete),
    accountDisabled: Boolean(user.accountDisabled),
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    lastApiActivityAt: user.lastApiActivityAt || usage?.lastTrackedRequestAt || null,
    notificationSettings: normalizeNotificationSettings(user.notificationSettings),
    subscription: {
      status: normalizeSubscriptionStatus(subscription?.status || user.subscriptionStatus || 'none') || 'none',
      productId: subscription?.productId || user.subscriptionProductId || null,
      updatedAt: subscription?.updatedAt || user.subscriptionUpdatedAt || null,
    },
    metrics: {
      trackedRequests: user.usageStats?.trackedRequests || 0,
      requests7d: usage?.requests7d || 0,
      requests30d: usage?.requests30d || 0,
      totalCheckIns: checkins?.totalCheckIns || 0,
      lastCheckInAt: checkins?.lastCheckInAt || null,
      totalInsights: insights?.totalInsights || 0,
      lastInsightAt: insights?.lastInsightAt || null,
      deviceCount: devices?.deviceCount || 0,
    },
  };
}

async function loadAdminUserDetail(db, uid) {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) return null;

  const since7d = daysAgo(7);
  const since30d = daysAgo(30);

  const [
    user,
    subscription,
    devices,
    checkins,
    insights,
    guidance,
    notifications,
    savedInsightsCount,
    usageSummary,
    endpointBreakdown,
    recentRequests,
    authUser,
  ] = await Promise.all([
    db.collection('users').findOne({ uid: normalizedUid }),
    db.collection('subscriptions').findOne({ uid: normalizedUid }),
    db.collection('device_tokens')
      .find({ uid: normalizedUid }, { projection: { fcmToken: 1, platform: 1, timezoneOffset: 1, createdAt: 1, updatedAt: 1 } })
      .sort({ updatedAt: -1 })
      .toArray(),
    db.collection('checkins')
      .aggregate([
        { $match: { uid: normalizedUid } },
        { $group: { _id: null, totalCheckIns: { $sum: 1 }, lastCheckInAt: { $max: '$timestamp' } } },
      ])
      .toArray(),
    db.collection('ai_insights')
      .aggregate([
        { $match: { uid: normalizedUid } },
        {
          $project: {
            generatedAt: 1,
            insightCount: { $size: { $ifNull: ['$insights', []] } },
          },
        },
        {
          $group: {
            _id: null,
            totalInsightBatches: { $sum: 1 },
            totalInsights: { $sum: '$insightCount' },
            lastInsightAt: { $max: '$generatedAt' },
          },
        },
      ])
      .toArray(),
    db.collection('ai_guidance')
      .aggregate([
        { $match: { uid: normalizedUid } },
        {
          $group: {
            _id: null,
            totalGuidance: { $sum: 1 },
            lastGuidanceAt: { $max: '$generatedAt' },
          },
        },
      ])
      .toArray(),
    db.collection('notification_log')
      .aggregate([
        { $match: { recipientUid: normalizedUid } },
        {
          $group: {
            _id: null,
            notificationsReceived: { $sum: 1 },
            lastNotificationAt: { $max: '$createdAt' },
          },
        },
      ])
      .toArray(),
    db.collection('saved_insights').countDocuments({ uid: normalizedUid }),
    db.collection('api_usage_events')
      .aggregate([
        { $match: { uid: normalizedUid, createdAt: { $gte: since30d } } },
        {
          $group: {
            _id: null,
            requests30d: { $sum: 1 },
            requests7d: {
              $sum: {
                $cond: [
                  { $gte: ['$createdAt', since7d] },
                  1,
                  0,
                ],
              },
            },
            errorRequests30d: {
              $sum: {
                $cond: [
                  { $gte: ['$statusCode', 400] },
                  1,
                  0,
                ],
              },
            },
            averageDurationMs30d: { $avg: '$durationMs' },
            lastTrackedRequestAt: { $max: '$createdAt' },
          },
        },
      ])
      .toArray(),
    db.collection('api_usage_events')
      .aggregate([
        { $match: { uid: normalizedUid, createdAt: { $gte: since30d } } },
        {
          $group: {
            _id: { method: '$method', route: '$route' },
            count: { $sum: 1 },
            errorCount: {
              $sum: {
                $cond: [
                  { $gte: ['$statusCode', 400] },
                  1,
                  0,
                ],
              },
            },
            averageDurationMs: { $avg: '$durationMs' },
            lastUsedAt: { $max: '$createdAt' },
          },
        },
        { $sort: { count: -1, lastUsedAt: -1 } },
        { $limit: 12 },
      ])
      .toArray(),
    db.collection('api_usage_events')
      .find(
        { uid: normalizedUid },
        { projection: { method: 1, route: 1, statusCode: 1, durationMs: 1, createdAt: 1 } }
      )
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray(),
    getAuthUser(normalizedUid),
  ]);

  if (!user && !authUser) {
    return null;
  }

  const checkinSummary = checkins[0] || {};
  const insightSummary = insights[0] || {};
  const guidanceSummary = guidance[0] || {};
  const notificationSummary = notifications[0] || {};
  const usage = usageSummary[0] || {};

  return {
    uid: normalizedUid,
    email: user?.email || authUser?.email || null,
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    displayName: buildDisplayName(user, authUser),
    gender: normalizeGender(user?.gender),
    dateOfBirth: user?.dateOfBirth || null,
    onboardingComplete: Boolean(user?.onboardingComplete),
    notificationSettings: normalizeNotificationSettings(user?.notificationSettings),
    subscription: {
      status: normalizeSubscriptionStatus(subscription?.status || user?.subscriptionStatus || 'none') || 'none',
      productId: subscription?.productId || user?.subscriptionProductId || null,
      environment: subscription?.environment || null,
      verifiedAt: subscription?.verifiedAt || null,
      updatedAt: subscription?.updatedAt || user?.subscriptionUpdatedAt || null,
    },
    accountDisabled: authUser?.disabled ?? Boolean(user?.accountDisabled),
    authAccount: authUser ? {
      email: authUser.email || null,
      emailVerified: Boolean(authUser.emailVerified),
      disabled: Boolean(authUser.disabled),
      displayName: authUser.displayName || null,
      createdAt: metadataDate(authUser.metadata?.creationTime),
      lastSignInAt: metadataDate(authUser.metadata?.lastSignInTime),
      lastRefreshAt: metadataDate(authUser.metadata?.lastRefreshTime),
    } : null,
    createdAt: user?.createdAt || metadataDate(authUser?.metadata?.creationTime),
    updatedAt: user?.updatedAt || null,
    lastApiActivityAt: user?.lastApiActivityAt || usage?.lastTrackedRequestAt || null,
    metrics: {
      trackedRequests: user?.usageStats?.trackedRequests || 0,
      requests7d: usage?.requests7d || 0,
      requests30d: usage?.requests30d || 0,
      errorRequests30d: usage?.errorRequests30d || 0,
      averageDurationMs30d: usage?.averageDurationMs30d ? Math.round(usage.averageDurationMs30d) : 0,
      totalCheckIns: checkinSummary.totalCheckIns || 0,
      lastCheckInAt: checkinSummary.lastCheckInAt || null,
      totalInsightBatches: insightSummary.totalInsightBatches || 0,
      totalInsights: insightSummary.totalInsights || 0,
      lastInsightAt: insightSummary.lastInsightAt || null,
      totalGuidance: guidanceSummary.totalGuidance || 0,
      lastGuidanceAt: guidanceSummary.lastGuidanceAt || null,
      savedInsightsCount,
      notificationsReceived: notificationSummary.notificationsReceived || 0,
      lastNotificationAt: notificationSummary.lastNotificationAt || null,
      deviceCount: devices.length,
    },
    devices: devices.map(device => ({
      id: device._id.toString(),
      platform: device.platform || 'ios',
      timezoneOffset: typeof device.timezoneOffset === 'number' ? device.timezoneOffset : null,
      tokenPreview: redactToken(device.fcmToken),
      createdAt: device.createdAt || null,
      updatedAt: device.updatedAt || null,
    })),
    endpointBreakdown: endpointBreakdown.map(item => ({
      method: item._id.method,
      route: item._id.route,
      count: item.count,
      errorCount: item.errorCount,
      averageDurationMs: item.averageDurationMs ? Math.round(item.averageDurationMs) : 0,
      lastUsedAt: item.lastUsedAt,
    })),
    recentRequests: recentRequests.map(item => ({
      id: item._id.toString(),
      method: item.method,
      route: item.route,
      statusCode: item.statusCode,
      durationMs: item.durationMs,
      createdAt: item.createdAt,
    })),
    requestTrackingNote: REQUEST_TRACKING_NOTE,
  };
}

function buildUserSearchFilter(search) {
  if (!search) return {};

  const pattern = new RegExp(escapeRegex(search), 'i');
  return {
    $or: [
      { uid: pattern },
      { email: pattern },
      { firstName: pattern },
      { lastName: pattern },
    ],
  };
}

function normalizeNotificationSettings(notificationSettings) {
  return {
    isEnabled: typeof notificationSettings?.isEnabled === 'boolean'
      ? notificationSettings.isEnabled
      : DEFAULT_NOTIFICATION_SETTINGS.isEnabled,
    checkInReminderFrequency: normalizeNotificationFrequency(notificationSettings?.checkInReminderFrequency)
      || DEFAULT_NOTIFICATION_SETTINGS.checkInReminderFrequency,
    insightsFrequency: normalizeNotificationFrequency(notificationSettings?.insightsFrequency)
      || DEFAULT_NOTIFICATION_SETTINGS.insightsFrequency,
  };
}

function normalizeNotificationFrequency(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return ALLOWED_NOTIFICATION_FREQUENCIES.has(normalized) ? normalized : null;
}

function normalizeGender(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return ALLOWED_GENDERS.has(normalized) ? normalized : null;
}

function normalizeSubscriptionStatus(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return ['active', 'expired', 'none'].includes(normalized) ? normalized : null;
}

function parseNullableDate(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildDisplayName(user, authUser = null) {
  const firstName = user?.firstName?.trim() || '';
  const lastName = user?.lastName?.trim() || '';
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) return fullName;
  if (authUser?.displayName) return authUser.displayName;
  if (user?.email) return user.email;
  if (authUser?.email) return authUser.email;
  return user?.uid || authUser?.uid || 'Unknown user';
}

function sortUsersForAdmin(a, b) {
  const aTime = newestTimestamp(a.lastApiActivityAt, a.metrics?.lastCheckInAt, a.createdAt);
  const bTime = newestTimestamp(b.lastApiActivityAt, b.metrics?.lastCheckInAt, b.createdAt);
  return bTime - aTime;
}

function newestTimestamp(...values) {
  return values.reduce((max, value) => {
    const next = value ? new Date(value).getTime() : 0;
    return next > max ? next : max;
  }, 0);
}

function mapBy(items, key) {
  return new Map(items.map(item => [item[key], item]));
}

function metadataDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function getAuthUser(uid) {
  try {
    return await admin.auth().getUser(uid);
  } catch (err) {
    if (isAuthUserNotFound(err)) return null;
    throw err;
  }
}

function isAuthUserNotFound(err) {
  return err?.code === 'auth/user-not-found' || err?.errorInfo?.code === 'auth/user-not-found';
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function clampInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function redactToken(token) {
  if (!token || typeof token !== 'string') return 'Unavailable';
  if (token.length <= 8) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getDeleteCount(result) {
  if (typeof result.deletedCount === 'number') return result.deletedCount;
  if (typeof result.matchedCount === 'number') return result.matchedCount;
  return 0;
}

module.exports = router;
