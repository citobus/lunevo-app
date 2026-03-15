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
index.js  →  connectDB() (MongoDB)  →  app.listen()
```

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | No | Liveness check → `{ status: "ok" }` |
| GET | `/checkins` | Yes | Fetch user's check-ins (paginated) |
| PUT | `/checkins` | Yes | Upsert by `clientId` (idempotent) |
| POST | `/checkins/bulk` | Yes | Bulk upsert up to 1000 |
| DELETE | `/checkins/by-client-id/:clientId` | Yes | Delete by UUID |
| GET | `/users/me` | Yes | Fetch or auto-create profile |
| PATCH | `/users/me` | Yes | Update profile |
| POST | `/ai/guidance` | Yes | Claude guidance for a phase |
| POST | `/ai/insights` | Yes | Claude weekly insights |
| GET | `/messages` | Yes | Fetch unread active broadcast messages for user |
| POST | `/messages/:id/dismiss` | Yes | Mark broadcast message dismissed (per-user, idempotent) |
| GET | `/admin/messages` | Admin | List all broadcast messages |
| POST | `/admin/messages` | Admin | Create broadcast message (`title`, `body`, optional `scheduledAt`) |
| PATCH | `/admin/messages/:id` | Admin | Update title/body/scheduledAt/status |
| DELETE | `/admin/messages/:id` | Admin | Permanently delete message + dismiss records |

## Auth Pattern

Every protected route uses `src/middleware/auth.js`:
- Reads `Authorization: Bearer <firebase-id-token>`
- Verifies with Firebase Admin SDK
- Attaches `req.user` (`{ uid, email, name }`)
- All DB queries must be scoped by `req.user.uid`

Admin routes additionally use `src/middleware/adminAuth.js`:
- Same token verification, then checks decoded email against `ADMIN_EMAILS` env var (comma-separated)
- Returns 403 if email not in list

## Key Files

```
index.js                       ← start server
src/app.js                     ← Express setup + route mounting + CORS for lunevoapp.com
src/middleware/auth.js         ← Firebase token verification
src/middleware/adminAuth.js    ← Admin email allowlist check
src/routes/checkins.js         ← check-in CRUD + bulk sync
src/routes/users.js            ← user profile
src/routes/ai.js               ← Claude guidance + insights
src/routes/messages.js         ← broadcast messages (user-facing)
src/routes/admin/messages.js   ← broadcast messages CRUD (admin only)
src/services/firebase.js       ← Firebase Admin SDK init
src/services/anthropic.js      ← Claude API wrapper
src/db/mongo.js                ← MongoDB connection + index creation
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

See `.env.example` for format. Never commit `.env`.

## MongoDB Collections

- `checkins` — indexed on `(uid, clientId)` unique + `(uid, timestamp)`
- `users` — indexed on `uid` unique; stores `dateOfBirth` (ISO date) and `gender` ("male" | "female" | "other")
- `broadcast_messages` — `{ title, body, status, scheduledAt, publishedAt, createdAt, updatedAt, createdBy }`; indexed on `(status, scheduledAt)`
- `message_reads` — `{ uid, messageId, dismissedAt }`; indexed on `(uid, messageId)` unique — tracks per-user dismissals
- `ai_guidance`, `ai_insights` — logging only

## AI Demographic Context

`src/routes/ai.js` looks up the user's `dateOfBirth` and `gender` from `users` collection on every `/ai/guidance` and `/ai/insights` request. It computes current age from DOB and appends a **silent** system-prompt instruction telling Claude to factor in age and gender when making recommendations — without ever mentioning them in the response. No new fields are required in the iOS request body.

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
