const { sendToUser, logNotification } = require('./fcm');

// ─── Shared helpers used by both POST /ai/insights and the cron scheduler ───

function sanitizeName(firstName, fallback) {
  if (typeof firstName === 'string' && firstName.trim().length > 0) {
    return firstName.trim();
  }
  return fallback;
}

function computeAge(dateOfBirth) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age > 0 && age < 130 ? age : null;
}

function buildDemographicContext(age, gender) {
  if (!age && !gender) return '';
  const parts = [];
  if (age) parts.push(`approximately ${age} years old`);
  if (gender) parts.push(`identifies as ${gender}`);
  return `\n\nSilent user context — do not reference directly: The user is ${parts.join(' and ')}. Let this silently inform your recommendations (e.g., age-appropriate sleep needs, energy patterns by life stage, hormonal considerations where relevant). NEVER mention or allude to their age or gender in your response.`;
}

function buildInsightsPrompt({ context, firstName, userAge, userGender }) {
  const name = sanitizeName(firstName, 'the user');
  const demographicContext = buildDemographicContext(userAge, userGender);

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
- Do not wrap the JSON in markdown fences${demographicContext}`,
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

/**
 * Send push notification when new insights are ready.
 * Respects insightsFrequency preference and rate limits.
 */
async function notifyInsightsAvailable(uid, db) {
  const user = await db.collection('users').findOne(
    { uid },
    { projection: { notificationSettings: 1, firstName: 1 } }
  );

  if (!user?.notificationSettings?.isEnabled) return;

  const freq = user.notificationSettings.insightsFrequency;
  if (freq === 'never') return;

  // Rate limit for "infrequent": max 1 insight notification per 7 days
  if (freq === 'infrequent') {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentCount = await db.collection('notification_log').countDocuments({
      type: 'insight_available',
      recipientUid: uid,
      createdAt: { $gte: weekAgo },
    });
    if (recentCount > 0) return;
  }

  const result = await sendToUser(uid, {
    title: 'New insights are ready',
    body: 'Your latest wellness patterns have been analyzed. Take a look!',
    data: { type: 'insight_available' },
  });

  if (result.sent > 0) {
    await logNotification({
      type: 'insight_available',
      title: 'New insights are ready',
      body: 'Your latest wellness patterns have been analyzed. Take a look!',
      recipientUid: uid,
      recipientCount: 1,
      sentCount: result.sent,
      failedCount: result.failed,
      triggeredBy: 'system',
    });
  }
}

module.exports = {
  sanitizeName,
  computeAge,
  buildDemographicContext,
  buildInsightsPrompt,
  extractJSONArray,
  notifyInsightsAvailable,
};
