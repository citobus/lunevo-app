const { sendMessage } = require('./anthropic');
const { getDB } = require('../db/mongo');
const { generateSnapshotContext, hasEnoughData } = require('./analyticsEngine');
const {
  computeAge,
  buildInsightsPrompt,
  extractJSONArray,
  notifyInsightsAvailable,
} = require('./insightHelpers');

const DEFAULT_INSIGHT_MODEL = process.env.INSIGHT_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

/**
 * Generate insights for a single user and store them.
 * Called by the cron scheduler.  Returns true if insights were generated.
 */
async function generateInsightsForUser(uid) {
  const db = getDB();

  // 1. Check data eligibility
  const eligible = await hasEnoughData(uid);
  if (!eligible) return false;

  // 2. Build analytics context
  const context = await generateSnapshotContext(uid);
  if (!context) return false;

  // 3. Fetch user profile for personalisation
  const user = await db.collection('users').findOne(
    { uid },
    { projection: { firstName: 1, dateOfBirth: 1, gender: 1 } }
  );
  const firstName = user?.firstName || null;
  const userAge = computeAge(user?.dateOfBirth);
  const userGender = user?.gender || null;

  // 4. Append previous insights to avoid repetition
  const prevDocs = await db.collection('ai_insights')
    .find({ uid })
    .sort({ generatedAt: -1 })
    .limit(3)
    .toArray();

  let fullContext = context;
  const prevInsights = prevDocs.flatMap(d => d.insights || []);
  if (prevInsights.length) {
    fullContext += '\n\nPREVIOUSLY GENERATED INSIGHTS (do not repeat these):\n';
    for (const ins of prevInsights.slice(0, 5)) {
      fullContext += `- ${ins.text}\n`;
    }
  }

  // 5. Call Claude
  const prompt = buildInsightsPrompt({ context: fullContext, firstName, userAge, userGender });
  const rawText = await sendMessage({
    systemPrompt: prompt.systemPrompt,
    userMessage: prompt.userMessage,
    model: DEFAULT_INSIGHT_MODEL,
    maxTokens: 2048,
    temperature: 0.5,
  });
  const insights = extractJSONArray(rawText);

  // 6. Store in ai_insights
  await db.collection('ai_insights').insertOne({
    uid,
    insights,
    model: DEFAULT_INSIGHT_MODEL,
    generatedAt: new Date(),
    source: 'cron',
  });

  // 7. Send push notification (non-blocking)
  notifyInsightsAvailable(uid, db).catch(() => {});

  return true;
}

module.exports = { generateInsightsForUser };
