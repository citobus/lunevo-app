# lunevo-backend — Claude Code Context

> **IMPORTANT FOR AI AGENTS:** After any meaningful change here (new route, schema change, new env var, deployment update, dependency change), you MUST update:
> 1. This file (`lunevo-backend/CLAUDE.md`)
> 2. `lunevo-backend/AGENTS.md` — the parallel AI agent context file in this directory
> 3. `../LUNEVO_PROJECT.md` → Sections 4 (Backend API), 7 (Railway Setup), and/or 9 (Env Vars)

Full project context: **[../LUNEVO_PROJECT.md](../LUNEVO_PROJECT.md)**

---

## What This Is

Node.js + Express 5 REST API. Acts as the secure proxy between the iOS app and Anthropic/MongoDB. Deployed on Railway.

**GitHub:** https://github.com/citobus/lunevo-app
**Live URL:** https://lunevo-app-production.up.railway.app

## Entry Point & Startup

```
index.js  →  connectDB() (MongoDB)  →  app.listen()  →  startScheduler()
```

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | No | Liveness check → `{ status: "ok" }` |
| GET | `/checkins` | Yes | Fetch user's check-ins (paginated) |
| PUT | `/checkins` | Yes | Upsert by `clientId` (idempotent) |
| POST | `/checkins/bulk` | Yes | Bulk upsert up to 1000 (rate-limited: 60/hr per user by default) |
| DELETE | `/checkins/by-client-id/:clientId` | Yes | Delete by UUID |
| GET | `/users/me` | Yes | Fetch or auto-create profile |
| PATCH | `/users/me` | Yes | Update profile |
| POST | `/ai/guidance` | Yes | Claude guidance for a phase (rate-limited) |
| POST | `/ai/insights` | Yes | Claude weekly insights (rate-limited) |
| GET | `/ai/insights` | Yes | Fetch server-generated insights (`?limit=N&since=ISO`) |
| GET | `/messages` | Yes | Fetch unread active broadcast messages for user |
| POST | `/messages/:id/dismiss` | Yes | Mark broadcast message dismissed (per-user, idempotent) |
| PUT | `/devices/token` | Yes | Register/update FCM device token |
| DELETE | `/devices/token` | Yes | Unregister FCM device token (e.g. on sign-out) |
| POST | `/subscriptions/verify` | Yes | Store/update subscription from StoreKit 2 transaction |
| GET | `/subscriptions/status` | Yes | Check subscription status for authenticated user |
| POST | `/subscriptions/expire` | Yes | Mark subscription as expired |
| GET | `/admin/messages` | Admin | List all broadcast messages |
| POST | `/admin/messages` | Admin | Create broadcast message (`title`, `body`, optional `scheduledAt`) |
| PATCH | `/admin/messages/:id` | Admin | Update title/body/scheduledAt/status |
| DELETE | `/admin/messages/:id` | Admin | Permanently delete message + dismiss records |
| POST | `/admin/notifications/send` | Admin | Send push notification to all (or targeted) users |
| GET | `/admin/notifications/log` | Admin | Recent notification log entries |
| GET | `/admin/notifications/stats` | Admin | Device/user notification stats |
| GET | `/admin/users/stats` | Admin | Rollup usage/subscription/account stats |
| GET | `/admin/users` | Admin | Searchable user list with usage summaries |
| GET | `/admin/users/:uid` | Admin | Per-user account + API usage detail |
| PATCH | `/admin/users/:uid` | Admin | Update account, notification, subscription, disabled state |
| DELETE | `/admin/users/:uid` | Admin | Permanently delete user account + related data |

## Auth Pattern

Every protected route uses `src/middleware/auth.js`:
- Reads `Authorization: Bearer <firebase-id-token>`
- Verifies with Firebase Admin SDK
- Attaches `req.user` (`{ uid, email, name }`)
- All DB queries must be scoped by `req.user.uid`

Admin routes additionally use `src/middleware/adminAuth.js`:
- Same token verification, then requires `decoded.email_verified === true`
- Checks decoded email against `ADMIN_EMAILS` env var (comma-separated)
- Returns 403 if email not in list

AI routes (`/ai/*`) additionally use `src/middleware/requireSubscription.js`:
- Checks the `subscriptions` collection for an active subscription record
- Returns 403 with `{ error: 'subscription_required' }` if no active subscription
- Fails open if the DB query errors (non-blocking)

## Key Files

```
index.js                            ← start server + scheduler
src/app.js                          ← Express setup + route mounting + CORS for lunevoapp.com
src/middleware/auth.js              ← Firebase token verification
src/middleware/adminAuth.js         ← Admin email allowlist check
src/middleware/trackUsage.js        ← Persists per-request API usage events + user activity counters
src/middleware/rateLimit.js         ← Per-user sliding window rate limiter (in-memory)
src/routes/checkins.js              ← check-in CRUD + bulk sync
src/routes/users.js                 ← user profile
src/routes/ai.js                    ← Claude guidance + insights (triggers insight notifications)
src/routes/messages.js              ← broadcast messages (user-facing)
src/routes/devices.js               ← FCM device token registration
src/routes/subscriptions.js         ← StoreKit 2 subscription verification + status
src/middleware/requireSubscription.js ← Middleware to enforce active subscription
src/routes/admin/messages.js        ← broadcast messages CRUD (admin only)
src/routes/admin/notifications.js   ← push notification admin endpoints (send, log, stats)
src/routes/admin/users.js           ← admin user management + usage analytics endpoints
src/services/firebase.js            ← Firebase Admin SDK init
src/services/anthropic.js           ← Claude API wrapper
src/services/fcm.js                 ← FCM notification sending (batched, stale token cleanup)
src/services/scheduler.js           ← Cron scheduler for check-in reminders + insight generation
src/services/analyticsEngine.js     ← Port of iOS AnalyticsEngine — builds prompt context from check-ins
src/services/insightHelpers.js      ← Shared helpers: prompt building, JSON extraction, notification
src/services/insightGenerator.js    ← Orchestrates per-user insight generation (Claude → MongoDB → push)
src/db/mongo.js                     ← MongoDB connection + index creation
```

## Environment Variables

| Var | Required | Notes |
|---|---|---|
| `PORT` | Auto | Set by Railway |
| `MONGODB_URI` | Yes | Atlas connection string |
| `MONGODB_DB_NAME` | No | Default: `lunevo` |
| `FIREBASE_PROJECT_ID` | Yes | `lunevo-app` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes | Full JSON as single line |
| `ANTHROPIC_API_KEY` | Yes | `sk-ant-...` |
| `DEFAULT_CLAUDE_MODEL` | No | Default: `claude-haiku-4-5-20251001` |
| `INSIGHT_CLAUDE_MODEL` | No | Default: `claude-haiku-4-5-20251001` (NOT Sonnet — both endpoints default to Haiku) |
| `ADMIN_EMAILS` | Yes (for admin portal) | Comma-separated Google account emails with admin access |
| `CHECKINS_BULK_RATE_LIMIT` | No | Max bulk sync requests per user per hour (default: 60) |
| `AI_GUIDANCE_RATE_LIMIT` | No | Max guidance requests per user per hour (default: 30) |
| `AI_INSIGHTS_RATE_LIMIT` | No | Max insights requests per user per hour (default: 10) |

See `.env.example` for format. Never commit `.env`.

## MongoDB Collections

- `checkins` — indexed on `(uid, clientId)` unique + `(uid, timestamp)`
- `users` — indexed on `uid` unique; stores `dateOfBirth` (ISO date) and `gender` ("male" | "female" | "other")
- `broadcast_messages` — `{ title, body, status, scheduledAt, publishedAt, createdAt, updatedAt, createdBy }`; indexed on `(status, scheduledAt)`
- `message_reads` — `{ uid, messageId, dismissedAt }`; indexed on `(uid, messageId)` unique — tracks per-user dismissals
- `device_tokens` — `{ uid, fcmToken, platform, timezoneOffset, createdAt, updatedAt }`; indexed on `(uid, fcmToken)` unique + `(uid)`
- `notification_log` — `{ type, title, body, recipientUid?, recipientCount, sentCount, failedCount, triggeredBy, createdAt }`; indexed on `(createdAt)` + `(recipientUid, createdAt)` for daily cap tracking
- `ai_insights` — `{ uid, insights: [{text, patternType, confidence}], source, generatedAt }`; indexed on `(uid, generatedAt)` — stores server-generated insight batches
- `ai_guidance` — logging only
- `subscriptions` — `{ uid, originalTransactionId, productId, environment, status, verifiedAt, createdAt, updatedAt }`; indexed on `(uid)` unique — stores per-user subscription state synced from iOS StoreKit 2
- `api_usage_events` — `{ uid, method, route, resource, statusCode, durationMs, createdAt, ... }`; indexed on `(uid, createdAt)`, `(createdAt)`, `(route, createdAt)` for admin usage analytics

## AI Demographic Context

`src/routes/ai.js` looks up the user's `dateOfBirth` and `gender` from `users` collection on every `/ai/guidance` and `/ai/insights` request. It computes current age from DOB and appends a **silent** system-prompt instruction telling Claude to factor in age and gender when making recommendations — without ever mentioning them in the response. No new fields are required in the iOS request body.

## Push Notifications (FCM)

Backend sends push notifications via Firebase Cloud Messaging (FCM) using the existing Firebase Admin SDK — no extra env vars needed.
Production iOS delivery is fully configured through Firebase, including the APNs key linkage required for live push notifications.

**Automatic notifications:**
- **Check-in reminders** — cron runs every 30 min, evaluates each user's `notificationSettings.checkInReminderFrequency`:
  - `often`: 2x/day (9am, 6pm user-local time), only if no check-in in 5 hours
  - `infrequent`: 1x/day (12pm), only if no check-in today
  - `never`: none
- **Insight generation + notifications** — cron scheduler runs every 15 min, generates insights via Claude for eligible users, stores in `ai_insights`, then sends push notification. Uses deterministic per-user randomization (SHA-256 seeded) to pick 2 daily time slots between (wake time + 1hr) and (bedtime − 1hr). Respects `notificationSettings.insightsFrequency`:
  - `often`: 2x/day; `infrequent`: 1x/day; `never`: none
  - Requires a check-in within the last 24 hours; inactive users are skipped
  - `POST /ai/insights` enforces the same 24-hour recent-check-in rule and returns an empty `insights` array when generation is skipped
- **Quiet hours:** 10pm–8am user-local time
- **Daily cap:** Max 3 per user per day across all types

**Manual notifications:** Admin portal `POST /admin/notifications/send` to push to all users.
**Admin user management:** `/admin/users*` endpoints power account edits, subscription overrides, per-user request analytics, disable, and permanent deletion.

**Device tokens:** iOS app registers FCM token via `PUT /devices/token` on sign-in and token refresh; unregisters via `DELETE /devices/token` on sign-out. Stale tokens auto-cleaned on send failure.

## Railway Deployment

```bash
# Run from this directory (lunevo-backend/)
railway status --json          # check linked project
railway logs --lines 200       # view logs
railway up --detach -m "msg"   # deploy
railway variable set KEY=val   # set env var
```

Health check: `GET /health` — must return 200.

## Rules for AI Agents

- Always scope MongoDB queries by `req.user.uid` — never query across users
- Use `clientId` for check-in upserts (idempotency), `_id` for direct access
- New routes must go through the auth middleware
- New env vars must be added to `.env.example` AND documented in this file AND in `LUNEVO_PROJECT.md` Section 9
- When Railway deployment status changes, update `LUNEVO_PROJECT.md` Section 7 checklist
