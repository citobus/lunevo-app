const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { sendMessage } = require('../services/anthropic');
const { getDB } = require('../db/mongo');
const {
  sanitizeName,
  computeAge,
  buildDemographicContext,
  buildInsightsPrompt,
  extractJSONArray,
  notifyInsightsAvailable,
} = require('../services/insightHelpers');

const router = express.Router();

const DEFAULT_GUIDANCE_MODEL = process.env.DEFAULT_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const DEFAULT_INSIGHT_MODEL = process.env.INSIGHT_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

// ─── Rate Limits (per user, sliding window) ─────────────────────────────────
const GUIDANCE_RATE_LIMIT = parseInt(process.env.AI_GUIDANCE_RATE_LIMIT, 10) || 30;   // per hour
const INSIGHTS_RATE_LIMIT = parseInt(process.env.AI_INSIGHTS_RATE_LIMIT, 10) || 10;   // per hour

const guidanceLimit = rateLimit({ windowMs: 3_600_000, max: GUIDANCE_RATE_LIMIT, key: 'ai:guidance' });
const insightsLimit = rateLimit({ windowMs: 3_600_000, max: INSIGHTS_RATE_LIMIT, key: 'ai:insights' });

router.use(requireAuth);

function buildGuidancePrompt({ phase, context, firstName, userAge, userGender }) {
    const name = sanitizeName(firstName, 'there');
    const demographicContext = buildDemographicContext(userAge, userGender);

    return {
        systemPrompt: `You are lunevo's AI wellness coach. Your job is to generate brief, warm, personalised guidance for a specific phase of the user's day.

Voice guidelines:
- Warm and personal, like a thoughtful coach who knows the user well
- Reference specific patterns from their data, not generic advice
- Suggest ("you might try"), never command ("you should")
- 2-3 sentences max, flowing prose only
- Never mention the prompt, the snapshot, or "the data"
- Don't address the user by their name (${name})${demographicContext}

Respond with ONLY the guidance text. No preamble, no bullets, no JSON.`,
        userMessage: `Generate ${phase} phase guidance for ${name}.

${context}`,
    };
}

router.post('/guidance', guidanceLimit, async (req, res) => {
    try {
        const { phase, context, firstName } = req.body;

        if (!phase || !context) {
            return res.status(400).json({ error: 'Missing required fields: phase, context' });
        }

        const db = getDB();
        const userProfile = await db.collection('users').findOne(
            { uid: req.user.uid },
            { projection: { dateOfBirth: 1, gender: 1 } }
        );
        const userAge = computeAge(userProfile?.dateOfBirth);
        const userGender = userProfile?.gender || null;

        const prompt = buildGuidancePrompt({ phase, context, firstName, userAge, userGender });
        const text = await sendMessage({
            systemPrompt: prompt.systemPrompt,
            userMessage: prompt.userMessage,
            model: DEFAULT_GUIDANCE_MODEL,
        });

        await db.collection('ai_guidance').insertOne({
            uid: req.user.uid,
            phase,
            text,
            model: DEFAULT_GUIDANCE_MODEL,
            generatedAt: new Date(),
        });

        return res.json({ phase, text, source: 'claude' });
    } catch (err) {
        console.error('POST /ai/guidance error:', err);
        return res.status(500).json({ error: err.message || 'Failed to generate guidance' });
    }
});

router.post('/insights', insightsLimit, async (req, res) => {
    try {
        const { context, firstName } = req.body;

        if (!context) {
            return res.status(400).json({ error: 'Missing required field: context' });
        }

        const db = getDB();
        const userProfile = await db.collection('users').findOne(
            { uid: req.user.uid },
            { projection: { dateOfBirth: 1, gender: 1 } }
        );
        const userAge = computeAge(userProfile?.dateOfBirth);
        const userGender = userProfile?.gender || null;

        const prompt = buildInsightsPrompt({ context, firstName, userAge, userGender });
        const rawText = await sendMessage({
            systemPrompt: prompt.systemPrompt,
            userMessage: prompt.userMessage,
            model: DEFAULT_INSIGHT_MODEL,
            maxTokens: 2048,
            temperature: 0.5,
        });
        const insights = extractJSONArray(rawText);

        await db.collection('ai_insights').insertOne({
            uid: req.user.uid,
            insights,
            model: DEFAULT_INSIGHT_MODEL,
            generatedAt: new Date(),
        });

        // Send push notification for new insights (non-blocking)
        notifyInsightsAvailable(req.user.uid, db).catch(() => {});

        return res.json({ insights, source: 'claude' });
    } catch (err) {
        console.error('POST /ai/insights error:', err);
        return res.status(500).json({ error: err.message || 'Failed to generate insights' });
    }
});

// ─── GET /ai/insights ────────────────────────────────────────────────────────
// Fetch the user's most recent server-generated insights.
router.get('/insights', async (req, res) => {
    try {
        const db = getDB();
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
        const since = req.query.since ? new Date(req.query.since) : null;

        const query = { uid: req.user.uid };
        if (since && !isNaN(since.getTime())) {
            query.generatedAt = { $gt: since };
        }

        const docs = await db.collection('ai_insights')
            .find(query)
            .sort({ generatedAt: -1 })
            .limit(limit)
            .toArray();

        // Flatten: each doc has an insights[] array — merge them with generatedAt
        const insights = [];
        for (const doc of docs) {
            if (!Array.isArray(doc.insights)) continue;
            for (const insight of doc.insights) {
                insights.push({
                    text: insight.text,
                    patternType: insight.patternType,
                    confidence: insight.confidence,
                    generatedAt: doc.generatedAt,
                });
            }
        }

        return res.json({ insights, source: 'server' });
    } catch (err) {
        console.error('GET /ai/insights error:', err);
        return res.status(500).json({ error: 'Failed to fetch insights' });
    }
});

module.exports = router;
