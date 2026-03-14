const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { sendMessage } = require('../services/anthropic');
const { getDB } = require('../db/mongo');

const router = express.Router();

const DEFAULT_GUIDANCE_MODEL = process.env.DEFAULT_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const DEFAULT_INSIGHT_MODEL = process.env.INSIGHT_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

router.use(requireAuth);

function sanitizeName(firstName, fallback) {
    if (typeof firstName === 'string' && firstName.trim().length > 0) {
        return firstName.trim();
    }

    return fallback;
}

function buildGuidancePrompt({ phase, context, firstName }) {
    const name = sanitizeName(firstName, 'there');

    return {
        systemPrompt: `You are lunevo's AI wellness coach. Your job is to generate brief, warm, personalised guidance for a specific phase of the user's day.

Voice guidelines:
- Warm and personal, like a thoughtful coach who knows the user well
- Reference specific patterns from their data, not generic advice
- Suggest ("you might try"), never command ("you should")
- 2-3 sentences max, flowing prose only
- Never mention the prompt, the snapshot, or "the data"
- Don't address the user by their name (${name}) 

Respond with ONLY the guidance text. No preamble, no bullets, no JSON.`,
        userMessage: `Generate ${phase} phase guidance for ${name}.

${context}`,
    };
}

function buildInsightsPrompt({ context, firstName }) {
    const name = sanitizeName(firstName, 'the user');

    return {
        systemPrompt: `You are lunevo's AI wellness analyst. Generate 2-4 concise, personalised insights about patterns in ${name}'s energy, focus, and wellbeing data.

Return ONLY a valid JSON array. Each element must have exactly these fields:
{
  "text": "<insight text, 2-3 sentences>",
  "patternType": "trend" | "correlation" | "anomaly",
  "confidence": <number 0.0-1.0>
}

Guidelines:
- Be specific and personal; name actual patterns, days, or phases when supported
- Avoid generic wellness advice
- Use "trend" for directional changes, "correlation" for linked patterns, and "anomaly" for unusual deviations
- Confidence must reflect how clearly the supplied context supports the claim
- Do not wrap the JSON in markdown fences`,
        userMessage: `Analyse this wellness data for ${name} and return insights as JSON:

${context}`,
    };
}

function extractJSONArray(rawText) {
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
        throw new Error('Claude did not return a valid JSON array');
    }

    return JSON.parse(jsonMatch[0]);
}

router.post('/guidance', async (req, res) => {
    try {
        const { phase, context, firstName } = req.body;

        if (!phase || !context) {
            return res.status(400).json({ error: 'Missing required fields: phase, context' });
        }

        const prompt = buildGuidancePrompt({ phase, context, firstName });
        const text = await sendMessage({
            systemPrompt: prompt.systemPrompt,
            userMessage: prompt.userMessage,
            model: DEFAULT_GUIDANCE_MODEL,
        });

        const db = getDB();
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

router.post('/insights', async (req, res) => {
    try {
        const { context, firstName } = req.body;

        if (!context) {
            return res.status(400).json({ error: 'Missing required field: context' });
        }

        const prompt = buildInsightsPrompt({ context, firstName });
        const rawText = await sendMessage({
            systemPrompt: prompt.systemPrompt,
            userMessage: prompt.userMessage,
            model: DEFAULT_INSIGHT_MODEL,
            maxTokens: 2048,
            temperature: 0.5,
        });
        const insights = extractJSONArray(rawText);

        const db = getDB();
        await db.collection('ai_insights').insertOne({
            uid: req.user.uid,
            insights,
            model: DEFAULT_INSIGHT_MODEL,
            generatedAt: new Date(),
        });

        return res.json({ insights, source: 'claude' });
    } catch (err) {
        console.error('POST /ai/insights error:', err);
        return res.status(500).json({ error: err.message || 'Failed to generate insights' });
    }
});

module.exports = router;
