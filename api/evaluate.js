// api/evaluate.js
// Periscope — Powered by Team Up
// Vercel serverless function — ES module syntax (export default)
//
// CHANGE LOG:
// — Behaviour-counting model replacing holistic 0–4 scoring
// — Single API call (team + leader tracked together, not two separate calls)
// — Contributions metric gated by speakersIdentified checkbox
// — Leader report gated by same checkbox
// — temperature: 0 for deterministic output
// — TARGET_DENSITY constants isolated for calibration without logic changes
// — Tone N/A threshold: Tone is N/A when NEITHER SAFE nor RACE individually
//   reaches 10 interventions. Confirmed by George Karseras 09/07/2026.
//   (Previously used combined total — corrected per v4 brief clarification.)
// — Tone N/A redistributes 8.11% weight proportionally across remaining items
// — Tone quality cap: Tone cannot exceed average of SAFE and RACE scores
//   Agreed by George Karseras 04/07/2026
// — Score floor fixed at 0 — negative scores not possible for team or leader
// — Leader report descriptors updated to: Great / OK / Poor Leadership
//   Per George Karseras MVP brief v4 08/07/2026

import { buildPrompt } from '../lib/prompt.js';

export const config = { maxDuration: 60 };

// ─── Calibration constants ────────────────────────────────────────────────────
//
// Adjust these values during calibration sessions against real transcripts.
// No other code changes are needed to tune scores.
//
// Derived from George's Green thresholds ÷ 20-minute baseline meeting.
// share      1.05    Green ≥ 21 pts ÷ 20 min
// ask        1.30    Green ≥ 26 pts ÷ 20 min
// facilitate 0.50    Green > 10 pts ÷ 20 min
// energise   1.30    Green ≥ 26 pts ÷ 20 min
// resolve    0.35    Green ≥ 7 pts ÷ 20 min
// actioning  0.80    Green ≥ 16 pts ÷ 20 min
// challenge  0.80    Green ≥ 16 pts ÷ 20 min
// economise  0.50    Green ≥ 10 pts ÷ 20 min

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

// Tone minimum-evidence threshold.
// Tone is N/A when NEITHER SAFE nor RACE individually reaches this value.
// If either SAFE >= 10 OR RACE >= 10, Tone is calculated.
// Confirmed by George Karseras 09/07/2026.
const TONE_MIN_EVENTS = 10;

// ─── Score weights ────────────────────────────────────────────────────────────
//
// Weights reflect pro-rata redistribution after Contributions (7.5%) was
// removed from the overall score. Verified against v4 brief 08/07/2026:
//   Start/Recovery  16.22%  (15 / 92.5)
//   SAFE            27.03%  (25 / 92.5)
//   RACE            27.03%  (25 / 92.5)
//   Tone             8.11%  (7.5 / 92.5)
//   Close           21.62%  (20 / 92.5)

// Default team weights — Contributions excluded, remaining rescaled to 100%
// Used when speakersIdentified = false (checkbox unticked)
const TEAM_WEIGHTS = {
  start: 15   / 92.5,
  safe:  25   / 92.5,
  race:  25   / 92.5,
  tone:  7.5  / 92.5,
  close: 20   / 92.5,
};

// Full team weights — Contributions included at 7.5%
// Used when speakersIdentified = true (checkbox ticked)
const TEAM_WEIGHTS_WITH_CONTRIBUTIONS = {
  start:         0.150,
  safe:          0.250,
  race:          0.250,
  tone:          0.075,
  contributions: 0.075,
  close:         0.200,
};

// Leader overall weights — Contributions always excluded from leader overall
// Identical to default TEAM_WEIGHTS
const LEADER_WEIGHTS = {
  start: 15   / 92.5,
  safe:  25   / 92.5,
  race:  25   / 92.5,
  tone:  7.5  / 92.5,
  close: 20   / 92.5,
};

// SAFE internal weights: A and E = 30%, S and F = 20%
const SAFE_WEIGHTS = {
  share:      0.20,
  ask:        0.30,
  facilitate: 0.20,
  energise:   0.30,
};

// RACE internal weights: A and C = 30%, R and E = 20%
const RACE_WEIGHTS = {
  resolve:   0.20,
  actioning: 0.30,
  challenge: 0.30,
  economise: 0.20,
};

// ─── RAG helpers ──────────────────────────────────────────────────────────────

function safeRaceRag(score) {
  if (score >= 80) return 'green';
  if (score >= 50) return 'amber';
  return 'red';
}

function startRag(penaltyPoints) {
  if (penaltyPoints === 0) return 'green';
  if (penaltyPoints <= 2)  return 'amber';
  return 'red';
}

function recoveryRag(points) {
  if (points >= 5) return 'green';
  if (points >= 2) return 'amber';
  return 'red';
}

function toneRag(ratio) {
  if (ratio >= 0.8 && ratio <= 1.4)                                    return 'green';
  if ((ratio > 1.4 && ratio < 1.8) || (ratio > 0.5 && ratio < 0.8))  return 'amber';
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
  if (achievedCount >= 4)  return 'green';
  if (achievedCount === 3) return 'amber';
  return 'red';
}

function clarityRag(score) {
  if (score > 30)  return 'green';
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

// Leader descriptors per George Karseras MVP brief v4 08/07/2026
function leaderDescriptor(score) {
  if (score >= 80) return 'Great Leadership';
  if (score >= 61) return 'OK Leadership';
  return 'Poor Leadership';
}

// ─── Per-behaviour normalisation ──────────────────────────────────────────────
//
// For each actionable agenda item:
//   normalisedScore = max(0, min(100, (rawPoints / durationMinutes) / targetDensity × 100))
// Final behaviour score = average across all actionable items.
// Floor of 0 prevents negative scores when negative events outweigh positive ones.

function normaliseByItem(byItemArray, agendaItems, behaviour) {
  const density = TARGET_DENSITY[behaviour];
  const scores  = [];

  for (const entry of (byItemArray || [])) {
    const item = (agendaItems || []).find(a => a.id === entry.itemId);
    if (!item || item.type !== 'actionable' || item.durationMinutes <= 0) continue;
    const ptsPerMin = entry.rawPoints / item.durationMinutes;
    scores.push(Math.max(0, Math.min(100, (ptsPerMin / density) * 100)));
  }

  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// Economise: add meeting-level completionBonus to the last item before normalising.
// The bonus is a single binary event (+3 on time / -3 over time) not a per-minute behaviour.

function normaliseEconomise(economise, agendaItems) {
  const bonus  = economise.completionBonus || 0;
  const byItem = economise.byItem || [];
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
// Reflects the leader's proportional contribution to the team total.
// Floor of 0 applied — leader raw points can be negative if they had many
// negative behaviours, but the reported score cannot go below zero.

function leaderBehaviourScore(leaderTotal, teamTotal) {
  if (!teamTotal || teamTotal <= 0) return 0;
  return Math.max(0, Math.min(100, (leaderTotal / teamTotal) * 100));
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

// ─── Tone quality cap ─────────────────────────────────────────────────────────
//
// Tone cannot exceed the average of SAFE and RACE scores.
// A meeting where both dimensions are weak cannot claim a healthy tone
// regardless of how balanced the SAFE:RACE ratio appears.
// Agreed by George Karseras 04/07/2026.

function applyToneQualityCap(toneResult, safeScore, raceScore) {
  if (toneResult.score === null) return toneResult;

  const qualityCap = Math.round((safeScore + raceScore) / 2);

  if (toneResult.score > qualityCap) {
    return {
      ...toneResult,
      score:           qualityCap,
      rag:             safeRaceRag(qualityCap),
      cappedByQuality: true,
    };
  }

  return toneResult;
}

// ─── Effective Start + Start Recovery ────────────────────────────────────────

function computeStart(effectiveStart, startRecovery) {
  const penalty = effectiveStart?.penaltyPoints || 0;
  const rag     = startRag(penalty);

  const startDisplayScore = rag === 'green' ? 100 : rag === 'amber' ? 60 : 30;

  if (rag === 'green') {
    return {
      effectiveStart: { score: 100, rag: 'green', penaltyPoints: 0 },
      startRecovery:  { applicable: false, score: null, rag: 'n/a', totalPoints: 0 },
      combinedScore:  100,
    };
  }

  const recoveryPoints = startRecovery?.totalPoints || 0;
  const recRag         = recoveryRag(recoveryPoints);
  const combinedScore  = recRag === 'green' ? 70 : recRag === 'amber' ? 50 : 0;

  return {
    effectiveStart: { score: startDisplayScore, rag, penaltyPoints: penalty },
    startRecovery:  { applicable: true, score: combinedScore, rag: recRag, totalPoints: recoveryPoints },
    combinedScore,
  };
}

// ─── Tone ─────────────────────────────────────────────────────────────────────
//
// N/A when NEITHER SAFE nor RACE individually reaches TONE_MIN_EVENTS (10).
// If either SAFE >= 10 OR RACE >= 10, Tone is calculated.
// Confirmed by George Karseras 09/07/2026.
// When N/A, the 8.11% weight is redistributed across remaining scored items.
// Quality cap applied separately after SAFE and RACE scores are available.

function scoreFromRatio(ratio) {
  const rag = toneRag(ratio);
  if (rag === 'green') {
    const distFromBalance = Math.abs(ratio - 1.0);
    return Math.round(100 - (distFromBalance / 0.4) * 20);
  }
  if (rag === 'amber') return 50;
  return 25;
}

function computeTone(tone) {
  const safeCount = tone?.safeEventCount || 0;
  const raceCount = tone?.raceEventCount || 0;

  // N/A when neither dimension individually reaches the threshold
  if (safeCount < TONE_MIN_EVENTS && raceCount < TONE_MIN_EVENTS) {
    return {
      score:            null,
      rag:              'n/a',
      ratio:            null,
      direction:        null,
      insufficientData: true,
      note:             'Insufficient behavioural data to assess tone reliably — requires at least 10 interventions in either SAFE or RACE',
    };
  }

  const ratio = safeCount / (raceCount || 1);
  return {
    score:     scoreFromRatio(ratio),
    rag:       toneRag(ratio),
    ratio:     Math.round(ratio * 100) / 100,
    direction: toneDirection(ratio),
  };
}

function computeLeaderTone(tone) {
  const safeCount = tone?.leaderSafeEventCount || 0;
  const raceCount = tone?.leaderRaceEventCount || 0;

  if (safeCount < TONE_MIN_EVENTS && raceCount < TONE_MIN_EVENTS) {
    return {
      score:            null,
      rag:              'n/a',
      ratio:            null,
      direction:        null,
      insufficientData: true,
      note:             'Insufficient behavioural data to assess tone reliably',
    };
  }

  const ratio = safeCount / (raceCount || 1);
  return {
    score:     scoreFromRatio(ratio),
    rag:       toneRag(ratio),
    ratio:     Math.round(ratio * 100) / 100,
    direction: toneDirection(ratio),
  };
}

// ─── Contributions (TDI) ─────────────────────────────────────────────────────
//
// NOTE: Contributions measures speaking time distribution only, not meeting
// quality. A bad meeting can legitimately score well here if speakers happened
// to share time evenly. Whether this should be subject to a quality cap is
// a decision for George to make once real client transcripts have been analysed.

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
  const speakers = contributions?.speakers || [];
  const shares   = speakers.map(s => s.wordSharePct || 0);
  const gini     = computeGini(shares);
  const tdiValue = Math.max(0, Math.min(1, 1 - gini));
  const score    = scoreTdi(tdiValue);

  const leaderSpeaker = leaderLabel
    ? speakers.find(s => s.name?.toLowerCase() === leaderLabel.toLowerCase())
    : null;

  return {
    score,
    rag:                tdiRag(tdiValue),
    tdiValue:           Math.round(tdiValue * 100) / 100,
    speakers,
    leaderWordSharePct: leaderSpeaker?.wordSharePct ?? null,
  };
}

// ─── Effective Close ──────────────────────────────────────────────────────────
// Weights: P 25%, O 10%, R 25%, T 40% — confirmed v4 brief 08/07/2026

function computeClose(effectiveClose) {
  const { planned, organised, responsible, timeConscious } = effectiveClose;

  const score = Math.round(
    (planned?.achieved       ? 25 : 0) +
    (organised?.achieved     ? 10 : 0) +
    (responsible?.achieved   ? 25 : 0) +
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
//
// Four paths depending on whether Contributions and Tone are available.
// When Tone is null (N/A), its 8.11% is redistributed proportionally.

// Without Contributions, without Tone (Start 15 + SAFE 25 + RACE 25 + Close 20 = 85)
function computeOverallNoTone({ start, safe, race, close }) {
  const score = Math.round(
    start * (15 / 85) +
    safe  * (25 / 85) +
    race  * (25 / 85) +
    close * (20 / 85)
  );
  return { score, rag: overallRag(score), descriptor: overallDescriptor(score) };
}

// Without Contributions, with Tone
function computeOverall({ start, safe, race, tone, close }) {
  const score = Math.round(
    start * TEAM_WEIGHTS.start +
    safe  * TEAM_WEIGHTS.safe  +
    race  * TEAM_WEIGHTS.race  +
    tone  * TEAM_WEIGHTS.tone  +
    close * TEAM_WEIGHTS.close
  );
  return { score, rag: overallRag(score), descriptor: overallDescriptor(score) };
}

// With Contributions, without Tone
// Tone 8.11% redistributed — same proportions as TEAM_WEIGHTS
function computeOverallWithContributionsNoTone({ start, safe, race, contributions, close }) {
  const score = Math.round(
    start         * TEAM_WEIGHTS.start +
    safe          * TEAM_WEIGHTS.safe  +
    race          * TEAM_WEIGHTS.race  +
    contributions * TEAM_WEIGHTS.tone  +
    close         * TEAM_WEIGHTS.close
  );
  return { score, rag: overallRag(score), descriptor: overallDescriptor(score) };
}

// With Contributions, with Tone
function computeOverallWithContributions({ start, safe, race, tone, contributions, close }) {
  const score = Math.round(
    start         * TEAM_WEIGHTS_WITH_CONTRIBUTIONS.start         +
    safe          * TEAM_WEIGHTS_WITH_CONTRIBUTIONS.safe          +
    race          * TEAM_WEIGHTS_WITH_CONTRIBUTIONS.race          +
    tone          * TEAM_WEIGHTS_WITH_CONTRIBUTIONS.tone          +
    contributions * TEAM_WEIGHTS_WITH_CONTRIBUTIONS.contributions +
    close         * TEAM_WEIGHTS_WITH_CONTRIBUTIONS.close
  );
  return { score, rag: overallRag(score), descriptor: overallDescriptor(score) };
}

// Leader overall — Contributions always excluded
function computeLeaderOverall({ start, safe, race, tone, close }) {
  if (tone === null) {
    const score = Math.round(
      start * (15 / 85) +
      safe  * (25 / 85) +
      race  * (25 / 85) +
      close * (20 / 85)
    );
    return { score, rag: overallRag(score), descriptor: leaderDescriptor(score) };
  }
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

async function runEvaluation(transcript, meetingType, leaderName, speakersIdentified, apiKey) {

  // Step 1: anonymise
  const { anonymisedTranscript, speakerMap } = anonymiseTranscript(transcript);

  // Step 2: find leader's anonymised label (only relevant if speakersIdentified)
  let leaderLabel    = null;
  let leaderNotFound = false;

  if (speakersIdentified && leaderName && leaderName.trim().length > 0) {
    const needle = leaderName.trim().toLowerCase();
    for (const [original, generic] of Object.entries(speakerMap)) {
      if (original.toLowerCase() === needle) {
        leaderLabel = generic;
        break;
      }
    }
    if (!leaderLabel) {
      leaderNotFound = true;
      console.log(`Leader not found: "${leaderName}" not in [${Object.keys(speakerMap).join(', ')}]`);
    }
  }

  // Step 3: single Claude API call
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
  const closeResult   = computeClose(raw.effectiveClose);
  const clarityResult = computeClarity(raw.dialogueClarity);
  const contribs      = computeContributions(raw.contributions, leaderLabel);

  // Compute Tone then apply quality cap (Tone ≤ average of SAFE and RACE)
  const toneResult = applyToneQualityCap(
    computeTone(raw.tone),
    safeResult.score,
    raceResult.score
  );

  const toneScore = toneResult.score; // null if N/A

  // Step 5: compute overall — four paths depending on checkbox and Tone availability
  let overall;
  if (speakersIdentified) {
    overall = toneScore !== null
      ? computeOverallWithContributions({
          start:         startResult.combinedScore,
          safe:          safeResult.score,
          race:          raceResult.score,
          tone:          toneScore,
          contributions: contribs.score,
          close:         closeResult.score,
        })
      : computeOverallWithContributionsNoTone({
          start:         startResult.combinedScore,
          safe:          safeResult.score,
          race:          raceResult.score,
          contributions: contribs.score,
          close:         closeResult.score,
        });
  } else {
    overall = toneScore !== null
      ? computeOverall({
          start: startResult.combinedScore,
          safe:  safeResult.score,
          race:  raceResult.score,
          tone:  toneScore,
          close: closeResult.score,
        })
      : computeOverallNoTone({
          start: startResult.combinedScore,
          safe:  safeResult.score,
          race:  raceResult.score,
          close: closeResult.score,
        });
  }

  // Step 6: assemble team result
  const result = {
    meta: {
      leaderName:           leaderLabel || null,
      speakersIdentified,
      totalDurationMinutes: raw.meetingMeta?.totalDurationMinutes || 0,
      actionableMinutes:    raw.meetingMeta?.actionableMinutes    || 0,
    },
    overall,
    effectiveStart:  startResult.effectiveStart,
    startRecovery:   startResult.startRecovery,
    safe:            safeResult,
    race:            raceResult,
    tone:            toneResult,
    contributions:   speakersIdentified
      ? contribs
      : { note: 'Omitted — speaker identification not confirmed' },
    dialogueClarity: clarityResult,
    effectiveClose:  closeResult,
  };

  // Step 7: leader report — only when checkbox ticked and leader identified
  if (speakersIdentified && leaderLabel) {
    const leaderSafe = computeLeaderSafeScore(raw.safe);
    const leaderRace = computeLeaderRaceScore(raw.race);

    // Apply quality cap to leader Tone as well
    const leaderTone = applyToneQualityCap(
      computeLeaderTone(raw.tone),
      leaderSafe.score,
      leaderRace.score
    );

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
      effectiveStart:  startResult.effectiveStart,
      startRecovery:   startResult.startRecovery,
      dialogueClarity: clarityResult,
      effectiveClose:  closeResult,
    };
  }

  if (speakersIdentified && leaderNotFound) {
    result.leaderNotFound = true;
  }

  return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    transcript,
    meetingType        = 'intact',
    leaderName         = null,
    speakersIdentified = false,
  } = req.body;

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
    const result = await runEvaluation(
      transcript,
      meetingType,
      leaderName,
      speakersIdentified,
      apiKey
    );
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
