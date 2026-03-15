# lunevo-backend — AI Agent Context

> **IMPORTANT FOR AI AGENTS:** After any meaningful change here (new route, schema change, new env var, deployment update, dependency change), you MUST update:
> 1. This file (`lunevo-backend/AGENTS.md`)
> 2. `../LUNEVO_PROJECT.md` → Sections 4 (Backend API), 7 (Railway Setup), and/or 9 (Env Vars)

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

## Auth Pattern

Every protected route uses `src/middleware/auth.js`:
- Reads `Authorization: Bearer <firebase-id-token>`
- Verifies with Firebase Admin SDK
- Attaches `req.user` (`{ uid, email, name }`)
- All DB queries must be scoped by `req.user.uid`

## Key Files

```
index.js                    ← start server
src/app.js                  ← Express setup + route mounting
src/middleware/auth.js      ← Firebase token verification
src/routes/checkins.js      ← check-in CRUD + bulk sync
src/routes/users.js         ← user profile
src/routes/ai.js            ← Claude guidance + insights
src/services/firebase.js    ← Firebase Admin SDK init
src/services/anthropic.js   ← Claude API wrapper
src/db/mongo.js             ← MongoDB connection + index creation
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

See `.env.example` for format. Never commit `.env`.

## MongoDB Collections

- `checkins` — indexed on `(uid, clientId)` unique + `(uid, timestamp)`
- `users` — indexed on `uid` unique; now stores `dateOfBirth` (ISO date) and `gender` ("male" | "female" | "other") when provided by the iOS app
- `ai_guidance`, `ai_insights` — reserved, not yet actively used

## AI Demographic Context

`src/routes/ai.js` looks up the user's `dateOfBirth` and `gender` from the `users` collection on every `/ai/guidance` and `/ai/insights` request. Age is computed from DOB at request time and appended as a **silent** system-prompt instruction — Claude uses it to tailor recommendations but NEVER mentions age or gender in its output. No new fields are required in the iOS request body.

## Known Deployment Note

The first Railway deploy after adding DOB/gender prompt personalization crashed at startup because `src/routes/ai.js` redeclared `const db` inside both AI handlers. The local hotfix keeps a single `db` variable per request handler; redeploy and re-check `GET /health` plus Railway logs after shipping.

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
