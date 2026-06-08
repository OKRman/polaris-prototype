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

  // ── Sub-scores (percent scale) ───────────────────────────────────────────────
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

  // ── Good practice definitions (mirrors sub-score structure) ──────────────────
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

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { transcript, meetingType = 'intact' } = req.body;

  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 50) {
    return res.status(400).json({ error: 'Please provide a meeting transcript of at least 50 characters.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: 'Server configuration error. Please contact support.' });
  }

  try {
    const systemPrompt = buildPrompt(meetingType);

    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3500,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `Please evaluate the following meeting transcript:\n\n${transcript.trim()}` },
        ],
      }),
    });

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      console.error('Anthropic API error:', apiResponse.status, errorBody);
      return res.status(502).json({ error: 'The AI analysis service is temporarily unavailable. Please try again.' });
    }

    const apiData = await apiResponse.json();
    const rawText = apiData.content?.[0]?.text;

    if (!rawText) {
      console.error('Unexpected API response shape:', JSON.stringify(apiData));
      return res.status(500).json({ error: 'Unexpected response from AI. Please try again.' });
    }

    // Strip any accidental markdown fences
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let raw;
    try {
      raw = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('JSON parse failed. Raw text was:', rawText.slice(0, 500));
      return res.status(500).json({ error: 'Could not parse the AI evaluation. Please try again.' });
    }

    // Validate the expected top-level keys from lib/prompt.js schema
    if (!raw.portIn || !raw.safe || !raw.race || !raw.portOut) {
      console.error('Response missing expected keys. Got:', Object.keys(raw));
      return res.status(500).json({ error: 'The AI returned an incomplete evaluation. Please try again.' });
    }

    // Transform raw Claude output to the structure index.html expects
    const result = transformResponse(raw, meetingType);

    return res.status(200).json(result);

  } catch (err) {
    console.error('Unhandled error in evaluate handler:', err);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}
