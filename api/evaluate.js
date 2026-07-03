// api/evaluate.js
// Periscope — Powered by Team Up
// Vercel serverless function — ES module syntax (export default)
//
// CHANGE FROM V1:
// This file now implements the full Polaris algorithm — normalisation, sub-score
// weighting, RAG derivation, leader report — against the new behaviour-counting
// schema returned by lib/prompt.js. The old transformResponse() function and its
// toPercent() / ragBand() helpers have been removed entirely.
//
// CALIBRATION: Adjust TARGET_DENSITY constants at the top of this file.
// No other logic changes are needed to tune scores after calibration sessions.
//
// INDEX.HTML NOTE: The output schema of this file has changed. index.html will
// not render correctly until it is updated to consume the new output schema.
// Test the API directly (POST to /api/evaluate) before updating the renderer.

import { buildPrompt } from '../lib/prompt.js';

export const config = { maxDuration: 60 };

// ─── Calibration constants ────────────────────────────────────────────────────
//
// Target density = ideal weighted points per minute for each behaviour.
// Derived from George's Green thresholds ÷ 20-minute baseline meeting.
// Adjust these values during calibration sessions — no other code changes needed.
//
// Behaviour       Candidate   Basis
// share           1.05        Green ≥ 21 pts ÷ 20 min
// ask             1.30        Green ≥ 26 pts ÷ 20 min
// facilitate      0.50        Green > 10 pts ÷ 20 min
// energise        1.30        Green ≥ 26 pts ÷ 20 min
// resolve         0.35        Green ≥ 7 pts ÷ 20 min
// actioning       0.80        Green ≥ 16 pts ÷ 20 min
// challenge       0.80        Green ≥ 16 pts ÷ 20 min
// economise       0.50        Green ≥ 10 pts ÷ 20 min

const TARGET_DENSITY = {
  share:      1.05,
  ask:        1.30,
  facilitate: 0.50,
  energise:   1.30,
  resolve:    0.35,
  actioning:  0.80,
  challenge:  0.80,
  economise:  0.50,
};

// ─── Score weights ────────────────────────────────────────────────────────────

// Team report overall weights (must sum to 1.0)
const TEAM_WEIGHTS = {
  start:         0.150,
  safe:          0.250,
  race:          0.250,
  tone:          0.075,
  contributions: 0.075,
  close:         0.200,
};

// Leader report overall weights — Contributions excluded, remainder rescaled to 100%
// Rescale factor: 100 / 92.5
const LEADER_WEIGHTS = {
  start: 15   / 92.5,
  safe:  25   / 92.5,
  race:  25   / 92.5,
  tone:  7.5  / 92.5,
  close: 20   / 92.5,
};

// SAFE internal weights: A and E = 30%, S and F = 20%
const SAFE_WEIGHTS = { share: 0.20, ask: 0.30, facilitate: 0.20, energise: 0.30 };

// RACE internal weights: A and C = 30%, R and E = 20%
const RACE_WEIGHTS = { resolve: 0.20, actioning: 0.30, challenge: 0.30, economise: 0.20 };

// ─── RAG helpers ──────────────────────────────────────────────────────────────

function safeRaceRag(score) {
  if (score >= 80) return 'green';
  if (score >= 50) return 'amber';
  return 'red';
}

function startRag(penaltyPoints) {
  if (penaltyPoints === 0)  return 'green';
  if (penaltyPoints <= 2)   return 'amber';
  return 'red';
}

function recoveryRag(points) {
  if (points >= 5) return 'green';
  if (points >= 2) return 'amber';
  return 'red';
}

function toneRag(ratio) {
  if (ratio >= 0.8 && ratio <= 1.4)                         return 'green';
  if ((ratio > 1.4 && ratio < 1.8) || (ratio > 0.5 && ratio < 0.8)) return 'amber';
  return 'red';
}

function toneDirection(ratio) {
  if (ratio >= 0.8 && ratio <= 1.4) return 'balanced';
  if (ratio > 1.4)                   return 'safety-heavy';
  return 'efficiency-heavy';
}

function tdiRag(tdiValue) {
  if (tdiValue > 0.75)  return 'green';
  if (tdiValue >= 0.55) return 'amber';
  return 'red';
}

function closeRag(achievedCount) {
  if (achievedCount >= 4) return 'green';
  if (achievedCount === 3) return 'amber';
  return 'red';
}

function clarityRag(score) {
  if (score > 30) return 'green';
  if (score >= 20) return 'amber';
  return 'red';
}

function overallRag(score) {
  if (score >= 80) return 'green';
  if (score >= 61) return 'amber';
  return 'red';
}

function overallDescriptor(score) {
  if (score >= 80) return 'Great Meeting';
  if (score >= 61) return 'Average Meeting';
  return 'Poor Meeting';
}

function leaderDescriptor(score) {
  if (score >= 80) return 'Strong Contribution';
  if (score >= 61) return 'Average Contribution';
  return 'Negative Contribution';
}

// ─── Per-behaviour normalisation ──────────────────────────────────────────────
//
// For each actionable agenda item:
//   normalisedScore = min(100, (rawPoints / durationMinutes) / targetDensity × 100)
// Final score = average across all actionable items.
//
// Returns 0 if no actionable items found.

function normaliseByItem(byItemArray, agendaItems, behaviour) {
  const density = TARGET_DENSITY[behaviour];
  const scores  = [];

  for (const entry of (byItemArray || [])) {
    const item = (agendaItems || []).find(a => a.id === entry.itemId);
    if (!item || item.type !== 'actionable' || item.durationMinutes <= 0) continue;

    const ptsPerMin = entry.rawPoints / item.durationMinutes;
    scores.push(Math.min(100, (ptsPerMin / density) * 100));
  }

  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// Economise special case: add the meeting-level completionBonus to the last
// actionable item's rawPoints before normalising, then normalise as normal.
// The bonus is a single binary event (finished on time or not).

function normaliseEconomise(economise, agendaItems) {
  const bonus   = economise.completionBonus || 0;
  const byItem  = economise.byItem || [];

  if (byItem.length === 0) return 0;

  const withBonus = byItem.map((entry, idx) =>
    idx === byItem.length - 1
      ? { ...entry, rawPoints: entry.rawPoints + bonus }
      : entry
  );

  return normaliseByItem(withBonus, agendaItems, 'economise');
}

// ─── SAFE score ───────────────────────────────────────────────────────────────

function computeSafeScore(safe, agendaItems) {
  const share      = normaliseByItem(safe.share.byItem,      agendaItems, 'share');
  const ask        = normaliseByItem(safe.ask.byItem,        agendaItems, 'ask');
  const facilitate = normaliseByItem(safe.facilitate.byItem, agendaItems, 'facilitate');
  const energise   = normaliseByItem(safe.energise.byItem,   agendaItems, 'energise');

  const score = Math.round(
    share      * SAFE_WEIGHTS.share      +
    ask        * SAFE_WEIGHTS.ask        +
    facilitate * SAFE_WEIGHTS.facilitate +
    energise   * SAFE_WEIGHTS.energise
  );

  return {
    score,
    rag: safeRaceRag(score),
    subScores: {
      share:      { score: Math.round(share),      rag: safeRaceRag(Math.round(share))      },
      ask:        { score: Math.round(ask),        rag: safeRaceRag(Math.round(ask))        },
      facilitate: { score: Math.round(facilitate), rag: safeRaceRag(Math.round(facilitate)) },
      energise:   { score: Math.round(energise),   rag: safeRaceRag(Math.round(energise))   },
    },
  };
}

// ─── RACE score ───────────────────────────────────────────────────────────────

function computeRaceScore(race, agendaItems) {
  const resolve   = normaliseByItem(race.resolve.byItem,   agendaItems, 'resolve');
  const actioning = normaliseByItem(race.actioning.byItem, agendaItems, 'actioning');
  const challenge = normaliseByItem(race.challenge.byItem, agendaItems, 'challenge');
  const economise = normaliseEconomise(race.economise,     agendaItems);

  const score = Math.round(
    resolve   * RACE_WEIGHTS.resolve   +
    actioning * RACE_WEIGHTS.actioning +
    challenge * RACE_WEIGHTS.challenge +
    economise * RACE_WEIGHTS.economise
  );

  return {
    score,
    rag: safeRaceRag(score),
    subScores: {
      resolve:   { score: Math.round(resolve),   rag: safeRaceRag(Math.round(resolve))   },
      actioning: { score: Math.round(actioning), rag: safeRaceRag(Math.round(actioning)) },
      challenge: { score: Math.round(challenge), rag: safeRaceRag(Math.round(challenge)) },
      economise: { score: Math.round(economise), rag: safeRaceRag(Math.round(economise)) },
    },
  };
}

// ─── Leader SAFE score ────────────────────────────────────────────────────────
//
// Leader score per behaviour = (leaderTotalRawPoints / teamTotalRawPoints) × 100
// Reflects the leader's proportional contribution to the team's total.

function leaderBehaviourScore(leaderTotal, teamTotal) {
  if (!teamTotal || teamTotal <= 0) return 0;
  return Math.min(100, (leaderTotal / teamTotal) * 100);
}

function computeLeaderSafeScore(safe) {
  const share      = leaderBehaviourScore(safe.share.leaderTotalRawPoints,      safe.share.totalRawPoints);
  const ask        = leaderBehaviourScore(safe.ask.leaderTotalRawPoints,        safe.ask.totalRawPoints);
  const facilitate = leaderBehaviourScore(safe.facilitate.leaderTotalRawPoints, safe.facilitate.totalRawPoints);
  const energise   = leaderBehaviourScore(safe.energise.leaderTotalRawPoints,   safe.energise.totalRawPoints);

  const score = Math.round(
    share      * SAFE_WEIGHTS.share      +
    ask        * SAFE_WEIGHTS.ask        +
    facilitate * SAFE_WEIGHTS.facilitate +
    energise   * SAFE_WEIGHTS.energise
  );

  return {
    score,
    rag: safeRaceRag(score),
    subScores: {
      share:      { score: Math.round(share),      rag: safeRaceRag(Math.round(share))      },
      ask:        { score: Math.round(ask),        rag: safeRaceRag(Math.round(ask))        },
      facilitate: { score: Math.round(facilitate), rag: safeRaceRag(Math.round(facilitate)) },
      energise:   { score: Math.round(energise),   rag: safeRaceRag(Math.round(energise))   },
    },
  };
}

// ─── Leader RACE score ────────────────────────────────────────────────────────

function computeLeaderRaceScore(race) {
  const resolve   = leaderBehaviourScore(race.resolve.leaderTotalRawPoints,   race.resolve.totalRawPoints);
  const actioning = leaderBehaviourScore(race.actioning.leaderTotalRawPoints, race.actioning.totalRawPoints);
  const challenge = leaderBehaviourScore(race.challenge.leaderTotalRawPoints, race.challenge.totalRawPoints);
  const economise = leaderBehaviourScore(race.economise.leaderTotalRawPoints, race.economise.totalRawPoints);

  const score = Math.round(
    resolve   * RACE_WEIGHTS.resolve   +
    actioning * RACE_WEIGHTS.actioning +
    challenge * RACE_WEIGHTS.challenge +
    economise * RACE_WEIGHTS.economise
  );

  return {
    score,
    rag: safeRaceRag(score),
    subScores: {
      resolve:   { score: Math.round(resolve),   rag: safeRaceRag(Math.round(resolve))   },
      actioning: { score: Math.round(actioning), rag: safeRaceRag(Math.round(actioning)) },
      challenge: { score: Math.round(challenge), rag: safeRaceRag(Math.round(challenge)) },
      economise: { score: Math.round(economise), rag: safeRaceRag(Math.round(economise)) },
    },
  };
}

// ─── Effective Start + Start Recovery ────────────────────────────────────────

function computeStart(effectiveStart, startRecovery) {
  const penalty = effectiveStart?.penaltyPoints || 0;
  const rag     = startRag(penalty);

  // Represent Effective Start score as a display figure
  // Green = 100, Amber = 60 (mid-band), Red = 30 (low)
  const startDisplayScore = rag === 'green' ? 100 : rag === 'amber' ? 60 : 30;

  if (rag === 'green') {
    return {
      effectiveStart: { score: 100, rag: 'green', penaltyPoints: 0 },
      startRecovery:  { applicable: false, score: null, rag: 'n/a', totalPoints: 0 },
      combinedScore:  100,
    };
  }

  // Recovery scoring applies when Effective Start is amber or red
  const recoveryPoints = startRecovery?.totalPoints || 0;
  const recRag         = recoveryRag(recoveryPoints);

  // Combined score fed into overall: Green recovery = 70, Amber = 50, Red = 0
  const combinedScore = recRag === 'green' ? 70 : recRag === 'amber' ? 50 : 0;

  return {
    effectiveStart: { score: startDisplayScore, rag, penaltyPoints: penalty },
    startRecovery:  { applicable: true, score: combinedScore, rag: recRag, totalPoints: recoveryPoints },
    combinedScore,
  };
}

// ─── Tone ─────────────────────────────────────────────────────────────────────

function scoreFromRatio(ratio) {
  const rag = toneRag(ratio);
  if (rag === 'green') {
    // Scale within Green (0.8–1.4): perfect balance (ratio = 1.0) = 100, edges = 80
    const distFromBalance = Math.abs(ratio - 1.0);
    const maxDist = 0.4;
    return Math.round(100 - (distFromBalance / maxDist) * 20);
  }
  if (rag === 'amber') return 70;
  return 40;
}

function computeTone(tone) {
  const safeCount = tone?.safeEventCount || 0;
  const raceCount = tone?.raceEventCount || 1; // avoid divide-by-zero
  const ratio     = safeCount / raceCount;
  return {
    score:     scoreFromRatio(ratio),
    rag:       toneRag(ratio),
    ratio:     Math.round(ratio * 100) / 100,
    direction: toneDirection(ratio),
  };
}

function computeLeaderTone(tone) {
  const safeCount = tone?.leaderSafeEventCount || 0;
  const raceCount = tone?.leaderRaceEventCount || 1;
  const ratio     = safeCount / raceCount;
  return {
    score:     scoreFromRatio(ratio),
    rag:       toneRag(ratio),
    ratio:     Math.round(ratio * 100) / 100,
    direction: toneDirection(ratio),
  };
}

// ─── Contributions (TDI) ─────────────────────────────────────────────────────
//
// Turn Distribution Index: 1 − Gini coefficient of speaker word-share proportions.
// A perfectly even distribution → TDI 1.0.
// Total dominance by one speaker → TDI approaching 0.

function computeGini(shares) {
  if (!shares || shares.length < 2) return 0;
  const n      = shares.length;
  const sorted = [...shares].sort((a, b) => a - b);
  const mean   = sorted.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0) return 0;

  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return Math.abs(numerator / (n * n * mean));
}

function scoreTdi(tdiValue) {
  if (tdiValue > 0.75)  return Math.round(80 + Math.min(20, ((tdiValue - 0.75) / 0.25) * 20));
  if (tdiValue >= 0.55) return Math.round(60 + ((tdiValue - 0.55) / 0.20) * 19);
  return Math.round(Math.max(0, (tdiValue / 0.55) * 59));
}

function computeContributions(contributions, leaderLabel) {
  const speakers   = contributions?.speakers || [];
  const shares     = speakers.map(s => s.wordSharePct || 0);
  const gini       = computeGini(shares);
  const tdiValue   = Math.max(0, Math.min(1, 1 - gini));
  const score      = scoreTdi(tdiValue);

  const leaderSpeaker = leaderLabel
    ? speakers.find(s => s.name?.toLowerCase() === leaderLabel.toLowerCase())
    : null;

  return {
    score,
    rag:               tdiRag(tdiValue),
    tdiValue:          Math.round(tdiValue * 100) / 100,
    speakers,
    leaderWordSharePct: leaderSpeaker?.wordSharePct ?? null,
  };
}

// ─── Effective Close ──────────────────────────────────────────────────────────
//
// Weights: planned 25%, organised 10%, responsible 25%, timeConscious 40%

function computeClose(effectiveClose) {
  const { planned, organised, responsible, timeConscious } = effectiveClose;

  const score = Math.round(
    (planned?.achieved      ? 25 : 0) +
    (organised?.achieved    ? 10 : 0) +
    (responsible?.achieved  ? 25 : 0) +
    (timeConscious?.achieved ? 40 : 0)
  );

  const achievedCount = [planned, organised, responsible, timeConscious]
    .filter(e => e?.achieved).length;

  return {
    score,
    rag: closeRag(achievedCount),
    elements: {
      planned:       { achieved: planned?.achieved       || false, weight: 0.25, evidence: planned?.evidence       || '' },
      organised:     { achieved: organised?.achieved     || false, weight: 0.10, evidence: organised?.evidence     || '' },
      responsible:   { achieved: responsible?.achieved   || false, weight: 0.25, evidence: responsible?.evidence   || '' },
      timeConscious: { achieved: timeConscious?.achieved || false, weight: 0.40, evidence: timeConscious?.evidence || '' },
    },
  };
}

// ─── Dialogue Clarity ────────────────────────────────────────────────────────

function computeClarity(dialogueClarity) {
  const score = dialogueClarity?.totalPoints || 0;
  return {
    score,
    rag:  clarityRag(score),
    note: 'For information only — does not contribute to overall score',
  };
}

// ─── Overall scores ───────────────────────────────────────────────────────────

function computeOverall({ start, safe, race, tone, contributions, close }) {
  const score = Math.round(
    start         * TEAM_WEIGHTS.start         +
    safe          * TEAM_WEIGHTS.safe          +
    race          * TEAM_WEIGHTS.race          +
    tone          * TEAM_WEIGHTS.tone          +
    contributions * TEAM_WEIGHTS.contributions +
    close         * TEAM_WEIGHTS.close
  );
  return { score, rag: overallRag(score), descriptor: overallDescriptor(score) };
}

function computeLeaderOverall({ start, safe, race, tone, close }) {
  const score = Math.round(
    start * LEADER_WEIGHTS.start +
    safe  * LEADER_WEIGHTS.safe  +
    race  * LEADER_WEIGHTS.race  +
    tone  * LEADER_WEIGHTS.tone  +
    close * LEADER_WEIGHTS.close
  );
  return { score, rag: overallRag(score), descriptor: leaderDescriptor(score) };
}

// ─── Anonymisation ────────────────────────────────────────────────────────────
//
// Replaces speaker labels in the transcript with Speaker A, Speaker B, etc.
// Returns { anonymisedTranscript, speakerMap } where speakerMap maps
// original labels to generic ones.

function anonymiseTranscript(transcript) {
  const speakerMap = {};
  const labels     = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let   idx        = 0;

  const anonymised = transcript.replace(
    /^([A-Za-z][A-Za-z0-9 .'\-]{0,40}):/gm,
    (match, name) => {
      const key = name.trim();
      if (!speakerMap[key]) {
        speakerMap[key] = `Speaker ${labels[idx % 26]}`;
        idx++;
      }
      return `${speakerMap[key]}:`;
    }
  );

  return { anonymisedTranscript: anonymised, speakerMap };
}

// ─── Main evaluation function ─────────────────────────────────────────────────

async function runEvaluation(transcript, meetingType, leaderName, apiKey) {
  // Step 1: anonymise
  const { anonymisedTranscript, speakerMap } = anonymiseTranscript(transcript);

  // Step 2: find the leader's anonymised label
  let leaderLabel    = null;
  let leaderNotFound = false;

  if (leaderName && leaderName.trim().length > 0) {
    const needle = leaderName.trim().toLowerCase();
    for (const [original, generic] of Object.entries(speakerMap)) {
      if (original.toLowerCase() === needle) {
        leaderLabel = generic;
        break;
      }
    }
    if (!leaderLabel) {
      leaderNotFound = true;
      console.log(`Leader not found: "${leaderName}" not matched in [${Object.keys(speakerMap).join(', ')}]`);
    }
  }

  // Step 3: build prompt and call Claude (single call — team + leader in one)
  const systemPrompt = buildPrompt(meetingType, leaderLabel);

  const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
   body: JSON.stringify({
      model:       'claude-sonnet-4-6',
      max_tokens:  4000,
      temperature: 0,
      system:      systemPrompt,
      messages: [
        {
          role:    'user',
          content: `Please analyse the following meeting transcript:\n\n${anonymisedTranscript.trim()}`,
        },
      ],
    }),
  });

  if (!apiResponse.ok) {
    const errorBody = await apiResponse.text();
    console.error('Anthropic API error:', apiResponse.status, errorBody);
    throw new Error(`API_ERROR:${apiResponse.status}`);
  }

  const apiData = await apiResponse.json();
  const rawText = apiData.content?.[0]?.text;
  if (!rawText) throw new Error('API_EMPTY_RESPONSE');

  // Strip any accidental markdown fences
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let raw;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    console.error('JSON parse failed. Raw text:', rawText.slice(0, 500));
    throw new Error('API_PARSE_FAILURE');
  }

  // Validate expected top-level keys
  const required = ['safe', 'race', 'effectiveStart', 'effectiveClose', 'tone', 'contributions'];
  const missing  = required.filter(k => !raw[k]);
  if (missing.length > 0) {
    console.error('Schema failure — missing keys:', missing, 'Got:', Object.keys(raw));
    throw new Error('API_SCHEMA_FAILURE');
  }

  // Step 4: compute all scores
  const agendaItems   = raw.agendaItems || [];
  const startResult   = computeStart(raw.effectiveStart, raw.startRecovery);
  const safeResult    = computeSafeScore(raw.safe,  agendaItems);
  const raceResult    = computeRaceScore(raw.race,  agendaItems);
  const toneResult    = computeTone(raw.tone);
  const closeResult   = computeClose(raw.effectiveClose);
  const clarityResult = computeClarity(raw.dialogueClarity);
  const contribs      = computeContributions(raw.contributions, leaderLabel);

  const overall = computeOverall({
    start:         startResult.combinedScore,
    safe:          safeResult.score,
    race:          raceResult.score,
    tone:          toneResult.score,
    contributions: contribs.score,
    close:         closeResult.score,
  });

  // Step 5: assemble team result
  const result = {
    meta: {
      leaderName:           leaderLabel || null,
      totalDurationMinutes: raw.meetingMeta?.totalDurationMinutes || 0,
      actionableMinutes:    raw.meetingMeta?.actionableMinutes    || 0,
    },
    overall,
    effectiveStart:  startResult.effectiveStart,
    startRecovery:   startResult.startRecovery,
    safe:            safeResult,
    race:            raceResult,
    tone:            toneResult,
    contributions:   contribs,
    dialogueClarity: clarityResult,
    effectiveClose:  closeResult,
  };

  // Step 6: leader report (only if leader was identified)
  if (leaderLabel) {
    const leaderSafe = computeLeaderSafeScore(raw.safe);
    const leaderRace = computeLeaderRaceScore(raw.race);
    const leaderTone = computeLeaderTone(raw.tone);

    const leaderOverall = computeLeaderOverall({
      start: startResult.combinedScore,
      safe:  leaderSafe.score,
      race:  leaderRace.score,
      tone:  leaderTone.score,
      close: closeResult.score,
    });

    result.leaderReport = {
      overall:        leaderOverall,
      safe:           leaderSafe,
      race:           leaderRace,
      tone:           leaderTone,
      contributions: {
        wordSharePct: contribs.leaderWordSharePct,
        note:         'Information only — not included in leader overall score',
      },
      // Shared elements — identical to team report
      effectiveStart:  startResult.effectiveStart,
      startRecovery:   startResult.startRecovery,
      dialogueClarity: clarityResult,
      effectiveClose:  closeResult,
    };
  }

  if (leaderNotFound) {
    result.leaderNotFound = true;
  }

  return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { transcript, meetingType = 'intact', leaderName = null } = req.body;

  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 50) {
    return res.status(400).json({
      error: 'Please provide a meeting transcript of at least 50 characters.',
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: 'Server configuration error. Please contact support.' });
  }

  try {
    const result = await runEvaluation(transcript, meetingType, leaderName, apiKey);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Unhandled error in evaluate handler:', err.message);

    if (err.message?.startsWith('API_ERROR:')) {
      return res.status(502).json({
        error: 'The AI analysis service is temporarily unavailable. Please try again.',
      });
    }
    if (err.message === 'API_PARSE_FAILURE' || err.message === 'API_SCHEMA_FAILURE') {
      return res.status(500).json({ error: 'Could not parse the AI evaluation. Please try again.' });
    }
    if (err.message === 'API_EMPTY_RESPONSE') {
      return res.status(500).json({ error: 'Unexpected response from AI. Please try again.' });
    }
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}
