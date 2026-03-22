# lunevo-backend — AI Agent Context

> **IMPORTANT FOR AI AGENTS:** After any meaningful change here (new route, schema change, new env var, deployment update, dependency change), you MUST update:
> 1. This file (`lunevo-backend/AGENTS.md`)
> 2. `lunevo-backend/CLAUDE.md` — the parallel Claude Code context file in this directory
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
| POST | `/ai/guidance` | Yes | Claude guidance for a phase (rate-limited: 30/hr) |
| POST | `/ai/insights` | Yes | Claude weekly insights (rate-limited: 10/hr, triggers push notification) |
| GET | `/ai/insights` | Yes | Fetch server-generated insights (`?limit=N&since=ISO`) |
| GET | `/messages` | Yes | Fetch unread active broadcast messages for user |
| POST | `/messages/:id/dismiss` | Yes | Mark broadcast message dismissed |
| PUT | `/devices/token` | Yes | Register/update FCM device token |
| DELETE | `/devices/token` | Yes | Unregister FCM device token |
| POST | `/subscriptions/verify` | Yes | Store/update subscription from StoreKit 2 transaction |
| GET | `/subscriptions/status` | Yes | Check subscription status for authenticated user |
| POST | `/subscriptions/expire` | Yes | Mark subscription as expired |
| GET | `/admin/messages` | Admin | List all broadcast messages |
| POST | `/admin/messages` | Admin | Create broadcast message |
| PATCH | `/admin/messages/:id` | Admin | Update message |
| DELETE | `/admin/messages/:id` | Admin | Delete message + dismiss records |
| POST | `/admin/notifications/send` | Admin | Send push notification to all/targeted users |
| GET | `/admin/notifications/log` | Admin | Recent notification log entries |
| GET | `/admin/notifications/stats` | Admin | Device/user notification stats |

## Auth Pattern

Every protected route uses `src/middleware/auth.js`:
- Reads `Authorization: Bearer <firebase-id-token>`
- Verifies with Firebase Admin SDK
- Attaches `req.user` (`{ uid, email, name }`)
- All DB queries must be scoped by `req.user.uid`

Admin routes additionally require `src/middleware/adminAuth.js` to verify the Firebase token again, require `decoded.email_verified === true`, and match the normalized email against `ADMIN_EMAILS`.

AI routes (`/ai/*`) additionally use `src/middleware/requireSubscription.js` to enforce an active subscription. Returns 403 `subscription_required` if no active record in the `subscriptions` collection. Fails open on DB errors.

## Key Files

```
index.js                            ← start server + scheduler
src/app.js                          ← Express setup + route mounting + CORS
src/middleware/auth.js              ← Firebase token verification
src/middleware/adminAuth.js         ← Admin email allowlist check
src/middleware/rateLimit.js         ← Per-user sliding window rate limiter (in-memory)
src/routes/checkins.js              ← check-in CRUD + bulk sync
src/routes/users.js                 ← user profile
src/routes/ai.js                    ← Claude guidance + insights (triggers insight notifications)
src/routes/messages.js              ← broadcast messages (user-facing)
src/routes/devices.js               ← FCM device token registration
src/routes/subscriptions.js         ← StoreKit 2 subscription verification + status
src/middleware/requireSubscription.js ← Middleware to enforce active subscription on AI routes
src/routes/admin/messages.js        ← broadcast messages CRUD (admin only)
src/routes/admin/notifications.js   ← push notification admin endpoints
src/services/firebase.js            ← Firebase Admin SDK init
src/services/anthropic.js           ← Claude API wrapper
src/services/fcm.js                 ← FCM notification sending
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
- `users` — indexed on `uid` unique; stores `dateOfBirth`, `gender`, `notificationSettings`
- `broadcast_messages` — indexed on `(status, scheduledAt)`
- `message_reads` — indexed on `(uid, messageId)` unique
- `device_tokens` — indexed on `(uid, fcmToken)` unique + `(uid)` — stores FCM tokens with timezone info
- `notification_log` — indexed on `(createdAt)` + `(recipientUid, createdAt)` — tracks all sent notifications for analytics and daily cap
- `ai_insights` — `{ uid, insights: [{text, patternType, confidence}], source, generatedAt }` — indexed on `(uid, generatedAt)` — stores server-generated insight batches
- `ai_guidance` — logging only

## Push Notifications (FCM)

Backend sends push notifications via Firebase Cloud Messaging using the existing Firebase Admin SDK.
Production iOS delivery is fully configured through Firebase, including the APNs key linkage required for live push notifications.

- **Check-in reminders:** Cron (every 30 min) evaluates users based on `notificationSettings.checkInReminderFrequency` (often/infrequent/never), timezone, quiet hours (10pm–8am), and daily cap (3/day)
- **Insight generation + notifications:** Cron (every 15 min) generates insights via Claude for eligible users using deterministic per-user time slots (SHA-256 seeded), stores in `ai_insights`, sends push notification. Respects `insightsFrequency` (often=2/day, infrequent=1/day, never=skip) and now skips users whose latest check-in is older than 24 hours. The direct `POST /ai/insights` route applies the same recent-check-in requirement and returns an empty `insights` array instead of generating new output when the user is inactive.
- **Admin manual:** `POST /admin/notifications/send` to push to all or targeted users
- **Device tokens:** Registered via `PUT /devices/token`, unregistered via `DELETE /devices/token`; stale tokens auto-cleaned

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
