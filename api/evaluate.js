// api/evaluate.js
// Periscope — Powered by Team Up
// Vercel serverless function — ES module syntax (export default)

import { buildPrompt } from '../lib/prompt.js';

// Extend Vercel function timeout to 60s. Default 10s is too short for Claude.
export const config = { maxDuration: 60 };

// ─── Scoring helpers ──────────────────────────────────────────────────────────

// Convert a 0.0–4.0 Claude score to a 0–100 percentage for the dashboard
function toPercent(score) {
  return Math.round((parseFloat(score) / 4) * 100);
}

// RAG band thresholds (percentage scale). Single source of truth.
// Red < 40  |  Amber 40–70  |  Green > 70
function ragBand(pct) {
  if (pct < 40)  return 'red';
  if (pct <= 70) return 'amber';
  return 'green';
}

// Build a dashboard metric object from a raw 0–4 score
function dashMetric(rawScore) {
  const pct = toPercent(rawScore);
  return { score: pct, rag: ragBand(pct) };
}

// Build a dashboard metric object from an already-computed 0–100 percentage
function dashMetricFromPct(pct) {
  const rounded = Math.round(pct);
  return { score: rounded, rag: ragBand(rounded) };
}

// Weighted average: pass alternating [value, weight] pairs
// e.g. weightedAvg(score1, 0.20, score2, 0.30, ...)
function weightedAvg(...pairs) {
  let total = 0;
  let weightSum = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    total     += pairs[i] * pairs[i + 1];
    weightSum += pairs[i + 1];
  }
  return weightSum > 0 ? total / weightSum : 0;
}

// Simple unweighted average of any number of raw 0–4 scores
function avg(...vals) {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ─── Anonymisation ────────────────────────────────────────────────────────────
//
// Replaces all speaker labels in the transcript with generic identifiers
// (Speaker A, Speaker B, …) before sending to the API.
// Returns { anonymisedTranscript, speakerMap } where speakerMap maps
// original labels to generic ones (used for leader matching).
//
// Handles the two most common transcript formats:
//   "Name: dialogue"
//   "Name\n00:00:00\ndialogue"  (Otter/Fireflies timestamp style)

function anonymiseTranscript(transcript) {
  const speakerMap   = {};   // originalLabel -> 'Speaker A', 'Speaker B', …
  const reverseMap   = {};   // 'Speaker A' -> originalLabel
  const labels       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let   labelIndex   = 0;

  // Match "Word(s) possibly with spaces/dots/hyphens:" at the start of a line
  const speakerRegex = /^([A-Za-z][A-Za-z0-9 .'\-]{0,40}):/gm;

  const anonymised = transcript.replace(speakerRegex, (match, name) => {
    const key = name.trim();
    if (!speakerMap[key]) {
      const label         = `Speaker ${labels[labelIndex % 26]}`;
      speakerMap[key]     = label;
      reverseMap[label]   = key;
      labelIndex++;
    }
    return `${speakerMap[key]}:`;
  });

  return { anonymisedTranscript: anonymised, speakerMap };
}

// ─── Leader extraction ────────────────────────────────────────────────────────
//
// Given an anonymised transcript and the speakerMap from anonymiseTranscript,
// finds the generic label for the supplied leaderName and returns only
// that speaker's lines as a new transcript string.
//
// Match is case-insensitive and trims whitespace.
// Returns null if no match is found.

function extractLeaderTranscript(anonymisedTranscript, speakerMap, leaderName) {
  if (!leaderName) return null;

  const needle = leaderName.trim().toLowerCase();

  // Find the generic label for this leader in speakerMap
  let leaderLabel = null;
  for (const [original, generic] of Object.entries(speakerMap)) {
    if (original.toLowerCase() === needle) {
      leaderLabel = generic;
      break;
    }
  }

  if (!leaderLabel) return null;

  // Extract all lines belonging to this speaker.
  // A speaker's turn starts at "Speaker X:" and runs until the next "Speaker Y:"
  // or end of string.
  const escapedLabel  = leaderLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const turnRegex     = new RegExp(
    `^(${escapedLabel}:.*?)(?=^[A-Za-z][A-Za-z0-9 .'\\-]{0,40}:|$(?![\s\S]))`,
    'gms'
  );

  const turns = [];
  let match;
  while ((match = turnRegex.exec(anonymisedTranscript)) !== null) {
    turns.push(match[1].trim());
  }

  if (turns.length === 0) return null;

  return turns.join('\n\n');
}

// ─── Response transformer ─────────────────────────────────────────────────────
//
// Claude returns the raw Polaris schema from lib/prompt.js:
//   { portIn: { purpose: { score, goodPractice }, ... }, safe: {...}, race: {...}, portOut: {...}, ... }
//
// index.html expects:
//   { meetingContext, meetingType, scores: { dashboard, subScores }, goodPractice, redFlags,
//     recommendations, behaviourDistribution }
//
// This function performs that transformation.

function transformResponse(raw, meetingType) {
  const { portIn, safe, race, portOut } = raw;

  // ── Sub-scores (percent scale) ──────────────────────────────────────────────
  const subScores = {
    portIn: {
      purpose:          { score: toPercent(portIn.purpose.score) },
      outcomes:         { score: toPercent(portIn.outcomes.score) },
      responsibilities: { score: toPercent(portIn.responsibilities.score) },
      timedAgenda:      { score: toPercent(portIn.timedAgenda.score) },
    },
    safe: {
      share:      { score: toPercent(safe.share.score) },
      ask:        { score: toPercent(safe.ask.score) },
      facilitate: { score: toPercent(safe.facilitate.score) },
      energise:   { score: toPercent(safe.energise.score) },
    },
    race: {
      resolve:   { score: toPercent(race.resolve.score) },
      actioning: { score: toPercent(race.actioning.score) },
      challenge: { score: toPercent(race.challenge.score) },
      economise: { score: toPercent(race.economise.score) },
    },
    portOut: {
      plan:             { score: toPercent(portOut.plan.score) },
      outcomes:         { score: toPercent(portOut.outcomes.score) },
      responsibilities: { score: toPercent(portOut.responsibilities.score) },
      time:             { score: toPercent(portOut.time.score) },
    },
  };

  // ── Good practice definitions (mirrors sub-score structure) ─────────────────
  const goodPractice = {
    portIn: {
      purpose:          { goodPractice: portIn.purpose.goodPractice          || '' },
      outcomes:         { goodPractice: portIn.outcomes.goodPractice         || '' },
      responsibilities: { goodPractice: portIn.responsibilities.goodPractice || '' },
      timedAgenda:      { goodPractice: portIn.timedAgenda.goodPractice      || '' },
    },
    safe: {
      share:      { goodPractice: safe.share.goodPractice      || '' },
      ask:        { goodPractice: safe.ask.goodPractice        || '' },
      facilitate: { goodPractice: safe.facilitate.goodPractice || '' },
      energise:   { goodPractice: safe.energise.goodPractice   || '' },
    },
    race: {
      resolve:   { goodPractice: race.resolve.goodPractice   || '' },
      actioning: { goodPractice: race.actioning.goodPractice || '' },
      challenge: { goodPractice: race.challenge.goodPractice || '' },
      economise: { goodPractice: race.economise.goodPractice || '' },
    },
    portOut: {
      plan:             { goodPractice: portOut.plan.goodPractice             || '' },
      outcomes:         { goodPractice: portOut.outcomes.goodPractice         || '' },
      responsibilities: { goodPractice: portOut.responsibilities.goodPractice || '' },
      time:             { goodPractice: portOut.time.goodPractice             || '' },
    },
  };

  // ── Dashboard metrics ────────────────────────────────────────────────────────
  //
  // Effective Start   = PORT In (all 4, unweighted average for dashboard card)
  // Psychological Safety = SAFE (all 4, unweighted average)
  // Decision Making Efficiency = RACE (all 4, unweighted average)
  // Effective Close   = PORT Out (all 4, unweighted average)
  // Clarity           = PORT In purpose+outcomes + PORT Out plan+outcomes
  //
  // Overall (weighted per George's brief):
  //   Effective Start 20% · Psychological Safety 20% · Decision Making Efficiency 20%
  //   Clarity 10% · Effective Close 30%
  //
  // One Team has been removed from the dashboard (agreed George & Graham, June 2026).

  const effectiveStart  = avg(portIn.purpose.score, portIn.outcomes.score, portIn.responsibilities.score, portIn.timedAgenda.score);
  const psychSafety     = avg(safe.share.score, safe.ask.score, safe.facilitate.score, safe.energise.score);
  const decisionQuality = avg(race.resolve.score, race.actioning.score, race.challenge.score, race.economise.score);
  const effectiveClose  = avg(portOut.plan.score, portOut.outcomes.score, portOut.responsibilities.score, portOut.time.score);
  const clarity         = avg(portIn.purpose.score, portIn.outcomes.score, portOut.plan.score, portOut.outcomes.score);

  // Overall: weighted composite on 0–4 scale, then converted to percent
  const overallRaw = weightedAvg(
    effectiveStart,  0.20,
    psychSafety,     0.20,
    decisionQuality, 0.20,
    clarity,         0.10,
    effectiveClose,  0.30
  );

  const scores = {
    dashboard: {
      overall:         dashMetric(overallRaw),
      effectiveStart:  dashMetric(effectiveStart),
      psychSafety:     dashMetric(psychSafety),
      decisionQuality: dashMetric(decisionQuality),
      effectiveClose:  dashMetric(effectiveClose),
      clarity:         dashMetric(clarity),
    },
    subScores,
  };

  return {
    meetingContext:        raw.meetingContext        || '',
    meetingType:           meetingType,
    scores,
    goodPractice,
    redFlags:              raw.redFlags              || [],
    recommendations:       raw.recommendations       || [],
    behaviourDistribution: raw.behaviourDistribution || null,
  };
}

// ─── Shared API call ──────────────────────────────────────────────────────────
//
// Sends a transcript to Claude with the Polaris prompt and returns
// the parsed, transformed result object.
// Throws on API error or parse failure — callers handle errors.

async function callPolarisAPI(transcript, meetingType, apiKey) {
  const systemPrompt = buildPrompt(meetingType);

  const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 3500,
      system:     systemPrompt,
      messages: [
        { role: 'user', content: `Please evaluate the following meeting transcript:\n\n${transcript.trim()}` },
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

  if (!rawText) {
    console.error('Unexpected API response shape:', JSON.stringify(apiData));
    throw new Error('API_EMPTY_RESPONSE');
  }

  // Strip any accidental markdown fences
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i,     '')
    .replace(/\s*```$/i,     '')
    .trim();

  let raw;
  try {
    raw = JSON.parse(cleaned);
  } catch (parseError) {
    console.error('JSON parse failed. Raw text was:', rawText.slice(0, 500));
    throw new Error('API_PARSE_FAILURE');
  }

  // Validate the expected top-level keys from lib/prompt.js schema
  if (!raw.portIn || !raw.safe || !raw.race || !raw.portOut) {
    console.error('Response missing expected keys. Got:', Object.keys(raw));
    throw new Error('API_SCHEMA_FAILURE');
  }

  return transformResponse(raw, meetingType);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { transcript, meetingType = 'intact', leaderName = null } = req.body;

  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 50) {
    return res.status(400).json({ error: 'Please provide a meeting transcript of at least 50 characters.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: 'Server configuration error. Please contact support.' });
  }

  try {
    // ── Step 1: Anonymise the transcript ──────────────────────────────────────
    // Speaker labels are replaced with Speaker A, Speaker B, etc. before any
    // data leaves this function. The speakerMap is retained only for leader matching.
    const { anonymisedTranscript, speakerMap } = anonymiseTranscript(transcript);

    // ── Step 2: Attempt leader extraction (if leaderName provided) ────────────
    let leaderTranscript = null;
    let leaderNotFound   = false;

    if (leaderName && typeof leaderName === 'string' && leaderName.trim().length > 0) {
      leaderTranscript = extractLeaderTranscript(anonymisedTranscript, speakerMap, leaderName);
      if (!leaderTranscript) {
        leaderNotFound = true;
        console.log(`Leader not found: "${leaderName}" had no match in speakerMap keys: [${Object.keys(speakerMap).join(', ')}]`);
      }
    }

    // ── Step 3: Run API calls in parallel ─────────────────────────────────────
    // Team report always runs. Leader report runs only if we have leader lines.
    // Both use the same prompt and schema — the difference is only the input.
    const teamPromise   = callPolarisAPI(anonymisedTranscript, meetingType, apiKey);
    const leaderPromise = leaderTranscript
      ? callPolarisAPI(leaderTranscript, meetingType, apiKey)
      : Promise.resolve(null);

    const [teamResult, leaderResult] = await Promise.all([teamPromise, leaderPromise]);

    // ── Step 4: Assemble and return response ──────────────────────────────────
    const response = { ...teamResult };

    if (leaderNotFound) {
      response.leaderNotFound = true;
    } else if (leaderResult) {
      response.leaderReport = leaderResult;
    }

    return res.status(200).json(response);

  } catch (err) {
    console.error('Unhandled error in evaluate handler:', err);

    if (err.message === 'API_ERROR:502' || err.message?.startsWith('API_ERROR:')) {
      return res.status(502).json({ error: 'The AI analysis service is temporarily unavailable. Please try again.' });
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
