const { getDB } = require('../db/mongo');

const RECENT_CHECKIN_WINDOW_MS = 24 * 60 * 60 * 1000;

// ─── Analytics Engine ───────────────────────────────────────────────────────
// Port of the iOS AnalyticsEngine.swift — builds the same prompt context text
// that Claude expects for insight generation.  Reads check-ins from MongoDB.

const PHASE_DISPLAY_NAMES = {
  wake_rise: 'Wake & Rise',
  morning: 'Morning',
  midday: 'Midday',
  afternoon: 'Afternoon',
  evening: 'Evening',
  nighttime: 'Nighttime',
  wind_down: 'Wind-Down',
};

const PHASE_ORDER = [
  'wake_rise', 'morning', 'midday', 'afternoon', 'evening', 'nighttime', 'wind_down',
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const THEME_DEFINITIONS = [
  { name: 'exercise', keywords: ['gym', 'workout', 'exercise', 'run', 'running', 'walk', 'walking', 'yoga', 'swim', 'cycling', 'hike', 'hiking', 'lift', 'weights', 'fitness'] },
  { name: 'sleep', keywords: ['sleep', 'slept', 'tired', 'exhausted', 'insomnia', 'nap', 'rested', 'fatigue', 'groggy'] },
  { name: 'stress', keywords: ['stress', 'stressed', 'anxious', 'anxiety', 'overwhelm', 'overwhelmed', 'pressure', 'tense', 'worry'] },
  { name: 'social', keywords: ['friends', 'family', 'meeting', 'lunch with', 'dinner with', 'date', 'party', 'hangout', 'social', 'call with'] },
  { name: 'work', keywords: ['work', 'project', 'deadline', 'meeting', 'presentation', 'office', 'client', 'email', 'task', 'productive'] },
  { name: 'nutrition', keywords: ['coffee', 'caffeine', 'meal', 'breakfast', 'lunch', 'dinner', 'snack', 'ate', 'food', 'hydrate', 'water', 'fasting'] },
  { name: 'outdoors', keywords: ['outside', 'outdoor', 'park', 'nature', 'sun', 'fresh air', 'garden', 'beach'] },
  { name: 'screen_time', keywords: ['screen', 'phone', 'social media', 'scrolling', 'netflix', 'tv', 'gaming'] },
  { name: 'meditation', keywords: ['meditat', 'mindful', 'breathe', 'breathing', 'calm', 'journal'] },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeAvg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function composite(c) {
  return (c.energy + c.focus + c.wellbeing) / 3;
}

function startOfDay(d) {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

function dayKey(d) {
  const s = startOfDay(d);
  return s.toISOString().slice(0, 10);
}

function formatSigned(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(1);
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ─── Core Snapshot Generation ───────────────────────────────────────────────

/**
 * Generate the full analytics snapshot for a user.
 * Returns the prompt context string identical to iOS DataSnapshot.toPromptContext().
 */
async function generateSnapshotContext(uid, referenceDate = new Date()) {
  const db = getDB();

  const cutoff28 = new Date(referenceDate);
  cutoff28.setDate(cutoff28.getDate() - 28);

  const cutoff14 = new Date(referenceDate);
  cutoff14.setDate(cutoff14.getDate() - 14);

  const cutoff7 = new Date(referenceDate);
  cutoff7.setDate(cutoff7.getDate() - 7);

  const checkIns28 = await db.collection('checkins')
    .find({ uid, timestamp: { $gte: cutoff28, $lt: referenceDate } })
    .sort({ timestamp: 1 })
    .toArray();

  if (!checkIns28.length) return null;

  const checkIns14 = checkIns28.filter(c => new Date(c.timestamp) >= cutoff14);
  const checkIns7 = checkIns28.filter(c => new Date(c.timestamp) >= cutoff7);
  const prior7 = checkIns14.filter(c => new Date(c.timestamp) < cutoff7);

  // Header stats
  const uniqueDays = new Set(checkIns28.map(c => dayKey(c.timestamp))).size;
  const avgPerDay = uniqueDays > 0 ? checkIns28.length / uniqueDays : 0;
  const firstCheckInAt = checkIns28[0].timestamp;

  const obsStart = startOfDay(firstCheckInAt);
  const obsEnd = startOfDay(referenceDate);
  const observationWindowDays = Math.max(
    Math.round((obsEnd - obsStart) / 86400000) + 1,
    1
  );
  const hasLimitedHistory = observationWindowDays < 7 || uniqueDays < 4;

  // Phase summaries (14d)
  const phaseSummaries = generatePhaseSummaries(checkIns14);

  // Weekly trajectory
  const weeklyTrajectory = generateWeeklyTrajectory(checkIns7, prior7);

  // Day of week patterns (28d)
  const dayOfWeekPatterns = generateDayOfWeekPatterns(checkIns28);

  // Note themes (14d)
  const noteThemes = extractNoteThemes(checkIns14);

  // Streaks (28d)
  const streaks = detectStreaks(checkIns28, referenceDate);

  // Phase correlations (14d)
  const phaseCorrelations = detectPhaseCorrelations(checkIns14);

  // Build prompt context (matches iOS toPromptContext exactly)
  return buildPromptContext({
    referenceDate,
    observationWindowDays,
    totalCheckIns28d: checkIns28.length,
    uniqueDays28d: uniqueDays,
    avgPerDay,
    hasLimitedHistory,
    phaseSummaries,
    weeklyTrajectory,
    dayOfWeekPatterns,
    noteThemes,
    streaks,
    phaseCorrelations,
  });
}

/**
 * Check if a user has enough data for insight generation.
 */
async function hasEnoughData(uid) {
  const db = getDB();

  const cutoff28 = new Date();
  cutoff28.setDate(cutoff28.getDate() - 28);

  const count = await db.collection('checkins').countDocuments({
    uid,
    timestamp: { $gte: cutoff28 },
  });

  if (count === 0) return false;

  const earliest = await db.collection('checkins')
    .findOne({ uid }, { sort: { timestamp: 1 }, projection: { timestamp: 1 } });

  if (!earliest) return false;

  return (Date.now() - new Date(earliest.timestamp).getTime()) >= 86400000;
}

async function getLastCheckInTime(uid) {
  const db = getDB();

  const latest = await db.collection('checkins')
    .findOne({ uid }, { sort: { timestamp: -1 }, projection: { timestamp: 1 } });

  return latest?.timestamp || null;
}

async function hasRecentCheckIn(uid, maxAgeMs = RECENT_CHECKIN_WINDOW_MS) {
  const lastCheckIn = await getLastCheckInTime(uid);
  if (!lastCheckIn) return false;

  return (Date.now() - new Date(lastCheckIn).getTime()) <= maxAgeMs;
}

// ─── Phase Summaries ────────────────────────────────────────────────────────

function generatePhaseSummaries(checkIns) {
  const byPhase = {};
  for (const c of checkIns) {
    (byPhase[c.phase] = byPhase[c.phase] || []).push(c);
  }

  const summaries = {};
  for (const phase of PHASE_ORDER) {
    const arr = byPhase[phase];
    if (!arr || !arr.length) continue;

    const composites = arr.map(composite);
    summaries[phase] = {
      phase,
      checkInCount: arr.length,
      avgEnergy: safeAvg(arr.map(c => c.energy)),
      avgFocus: safeAvg(arr.map(c => c.focus)),
      avgWellbeing: safeAvg(arr.map(c => c.wellbeing)),
      avgComposite: safeAvg(composites),
      minComposite: Math.min(...composites),
      maxComposite: Math.max(...composites),
      trend: computePhaseTrend(arr),
    };
  }

  return summaries;
}

function computePhaseTrend(checkIns) {
  if (checkIns.length < 4) return 'stable';
  const sorted = [...checkIns].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const half = Math.floor(sorted.length / 2);
  const firstAvg = safeAvg(sorted.slice(0, half).map(composite));
  const secondAvg = safeAvg(sorted.slice(-half).map(composite));
  const delta = secondAvg - firstAvg;
  if (delta > 0.4) return 'improving';
  if (delta < -0.4) return 'declining';
  return 'stable';
}

// ─── Weekly Trajectory ──────────────────────────────────────────────────────

function generateWeeklyTrajectory(recent, prior) {
  return {
    compositeDelta: safeAvg(recent.map(composite)) - safeAvg(prior.map(composite)),
    energyDelta: safeAvg(recent.map(c => c.energy)) - safeAvg(prior.map(c => c.energy)),
    focusDelta: safeAvg(recent.map(c => c.focus)) - safeAvg(prior.map(c => c.focus)),
    wellbeingDelta: safeAvg(recent.map(c => c.wellbeing)) - safeAvg(prior.map(c => c.wellbeing)),
    hasMeaningfulData: recent.length >= 3 && prior.length >= 3,
  };
}

// ─── Day-of-Week Patterns ───────────────────────────────────────────────────

function generateDayOfWeekPatterns(checkIns) {
  const byDay = {};
  for (const c of checkIns) {
    const wd = new Date(c.timestamp).getDay(); // 0=Sun
    (byDay[wd] = byDay[wd] || []).push(c);
  }

  return Object.entries(byDay)
    .map(([wd, arr]) => ({
      weekday: Number(wd),
      weekdayName: DAY_NAMES[Number(wd)],
      averageScore: safeAvg(arr.map(composite)),
      checkInCount: arr.length,
    }))
    .sort((a, b) => b.averageScore - a.averageScore);
}

// ─── Note Themes ────────────────────────────────────────────────────────────

function extractNoteThemes(checkIns) {
  const noted = checkIns.filter(c => c.note && c.note.trim());
  if (!noted.length) return [];

  const overallAvg = safeAvg(checkIns.map(composite));
  const themes = [];

  for (const def of THEME_DEFINITIONS) {
    const matching = noted.filter(c => {
      const note = c.note.toLowerCase();
      return def.keywords.some(kw => note.includes(kw));
    });

    if (matching.length < 2) continue;

    const matchAvg = safeAvg(matching.map(composite));
    themes.push({
      name: def.name,
      mentionCount: matching.length,
      averageScoreWhenMentioned: matchAvg,
      overallAverageScore: overallAvg,
      scoreDelta: matchAvg - overallAvg,
    });
  }

  return themes.sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta));
}

// ─── Streaks ────────────────────────────────────────────────────────────────

function detectStreaks(checkIns, referenceDate) {
  const daySet = [...new Set(checkIns.map(c => dayKey(c.timestamp)))].sort().reverse();
  const refKey = dayKey(referenceDate);

  // Current check-in streak
  let currentStreak = 0;
  let cursorDate = new Date(startOfDay(referenceDate));
  for (const dk of daySet) {
    if (dk === dayKey(cursorDate)) {
      currentStreak++;
      cursorDate.setDate(cursorDate.getDate() - 1);
    } else {
      break;
    }
  }

  // High score streak (avg composite >= 3.5)
  let highScoreStreak = 0;
  cursorDate = new Date(startOfDay(referenceDate));
  for (const dk of daySet) {
    if (dk === dayKey(cursorDate)) {
      const dayCheckIns = checkIns.filter(c => dayKey(c.timestamp) === dk);
      const dayAvg = safeAvg(dayCheckIns.map(composite));
      if (dayAvg >= 3.5) {
        highScoreStreak++;
        cursorDate.setDate(cursorDate.getDate() - 1);
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // Longest consecutive day streak
  let longest = 0;
  let streak = 0;
  let prev = null;
  for (const dk of [...daySet].reverse()) {
    if (prev) {
      const prevDate = new Date(prev);
      prevDate.setDate(prevDate.getDate() + 1);
      if (dayKey(prevDate) === dk) {
        streak++;
      } else {
        longest = Math.max(longest, streak);
        streak = 1;
      }
    } else {
      streak = 1;
    }
    prev = dk;
  }
  longest = Math.max(longest, streak);

  return { currentCheckInStreak: currentStreak, highScoreStreak, longestCheckInStreak: longest };
}

// ─── Phase Correlations ─────────────────────────────────────────────────────

function detectPhaseCorrelations(checkIns) {
  const correlations = [];
  for (let i = 0; i < PHASE_ORDER.length - 1; i++) {
    const corr = computePhaseCorrelation(PHASE_ORDER[i], PHASE_ORDER[i + 1], checkIns);
    if (corr) correlations.push(corr);
  }
  return correlations;
}

function computePhaseCorrelation(source, target, checkIns) {
  const byDay = {};
  for (const c of checkIns) {
    const dk = dayKey(c.timestamp);
    (byDay[dk] = byDay[dk] || []).push(c);
  }

  let sourceHighTargetHigh = 0;
  let sourceHighTargetLow = 0;
  let pairCount = 0;

  for (const dayCheckIns of Object.values(byDay)) {
    const srcArr = dayCheckIns.filter(c => c.phase === source);
    const tgtArr = dayCheckIns.filter(c => c.phase === target);
    if (!srcArr.length || !tgtArr.length) continue;

    const srcAvg = safeAvg(srcArr.map(composite));
    const tgtAvg = safeAvg(tgtArr.map(composite));
    pairCount++;
    if (srcAvg >= 3.5 && tgtAvg >= 3.5) sourceHighTargetHigh++;
    if (srcAvg >= 3.5 && tgtAvg < 3.0) sourceHighTargetLow++;
  }

  if (pairCount < 3) return null;

  const carryRate = sourceHighTargetHigh / pairCount;
  const dropRate = sourceHighTargetLow / pairCount;
  if (carryRate <= 0.5 && dropRate <= 0.4) return null;

  return {
    sourcePhase: source,
    targetPhase: target,
    carryOverRate: carryRate,
    dropOffRate: dropRate,
    sampleSize: pairCount,
    type: carryRate > 0.5 ? 'positive' : 'negative',
  };
}

// ─── Prompt Context Builder ─────────────────────────────────────────────────
// Replicates iOS DataSnapshot.toPromptContext() exactly.

function buildPromptContext({
  referenceDate, observationWindowDays, totalCheckIns28d, uniqueDays28d,
  avgPerDay, hasLimitedHistory, phaseSummaries, weeklyTrajectory,
  dayOfWeekPatterns, noteThemes, streaks, phaseCorrelations,
}) {
  const lines = [
    `SNAPSHOT DATE: ${formatDate(referenceDate)}`,
    `OBSERVATION WINDOW (DAYS): ${observationWindowDays}`,
    `CHECK-INS (28D): ${totalCheckIns28d}`,
    `UNIQUE DAYS (28D): ${uniqueDays28d}`,
    `AVG CHECK-INS PER DAY: ${avgPerDay.toFixed(1)}`,
    '',
  ];

  if (hasLimitedHistory) {
    lines.push('DATA LIMITATION: This is early-stage data with a short observation window.');
    lines.push('DATA LIMITATION RULE: Do not describe tracking consistency, check-in habits, weekly routines, or 28-day behavior yet.');
    lines.push('DATA LIMITATION RULE: Only comment on patterns directly supported by the small number of observed days/check-ins.');
    lines.push('');
  }

  lines.push('PHASE SUMMARIES:');
  const hasAnySummary = PHASE_ORDER.some(p => phaseSummaries[p]);
  if (!hasAnySummary) {
    lines.push('- No phase summaries available yet.');
  } else {
    for (const phase of PHASE_ORDER) {
      const s = phaseSummaries[phase];
      if (!s) continue;
      lines.push(
        `- ${PHASE_DISPLAY_NAMES[phase]}: ${s.checkInCount} check-ins | energy ${s.avgEnergy.toFixed(1)} | focus ${s.avgFocus.toFixed(1)} | wellbeing ${s.avgWellbeing.toFixed(1)} | composite ${s.avgComposite.toFixed(1)} | range ${s.minComposite.toFixed(1)}-${s.maxComposite.toFixed(1)} | trend ${s.trend}`
      );
    }
  }

  lines.push('');
  lines.push(
    `WEEKLY TRAJECTORY: composite ${formatSigned(weeklyTrajectory.compositeDelta)} | energy ${formatSigned(weeklyTrajectory.energyDelta)} | focus ${formatSigned(weeklyTrajectory.focusDelta)} | wellbeing ${formatSigned(weeklyTrajectory.wellbeingDelta)}`
  );

  lines.push('');
  lines.push('DAY-OF-WEEK PATTERNS:');
  if (!dayOfWeekPatterns.length) {
    lines.push('- None detected.');
  } else {
    for (const p of dayOfWeekPatterns.slice(0, 7)) {
      lines.push(`- ${p.weekdayName}: avg ${p.averageScore.toFixed(1)} (${p.checkInCount} check-ins)`);
    }
  }

  lines.push('');
  lines.push('NOTE THEMES:');
  if (!noteThemes.length) {
    lines.push('- None detected.');
  } else {
    for (const t of noteThemes.slice(0, 8)) {
      lines.push(
        `- ${t.name}: ${t.mentionCount} mentions | avg ${t.averageScoreWhenMentioned.toFixed(1)} vs overall ${t.overallAverageScore.toFixed(1)} | delta ${formatSigned(t.scoreDelta)}`
      );
    }
  }

  lines.push('');
  lines.push(
    `STREAKS: check-in ${streaks.currentCheckInStreak}d | high-score ${streaks.highScoreStreak}d | longest ${streaks.longestCheckInStreak}d`
  );

  lines.push('');
  lines.push('PHASE CORRELATIONS:');
  if (!phaseCorrelations.length) {
    lines.push('- None detected.');
  } else {
    for (const c of phaseCorrelations) {
      lines.push(
        `- ${PHASE_DISPLAY_NAMES[c.sourcePhase]} -> ${PHASE_DISPLAY_NAMES[c.targetPhase]} | type ${c.type} | carry ${Math.round(c.carryOverRate * 100)}% | drop ${Math.round(c.dropOffRate * 100)}% | samples ${c.sampleSize}`
      );
    }
  }

  return lines.join('\n');
}

module.exports = {
  RECENT_CHECKIN_WINDOW_MS,
  generateSnapshotContext,
  getLastCheckInTime,
  hasEnoughData,
  hasRecentCheckIn,
};
