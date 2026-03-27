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

// Average any number of raw 0–4 scores
function avg(...vals) {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ─── Response transformer ─────────────────────────────────────────────────────
//
// Claude returns the raw Polaris schema from lib/prompt.js:
//   { portIn: { purpose: { score, evidence }, ... }, safe: {...}, race: {...}, portOut: {...}, ... }
//
// index.html expects:
//   { meetingContext, meetingType, scores: { dashboard, subScores }, evidence, redFlags,
//     recommendations, behaviourDistribution }
//
// This function performs that transformation.

function transformResponse(raw, meetingType) {
  const { portIn, safe, race, portOut } = raw;

  // ── Sub-scores (percent scale, evidence separated) ──────────────────────────
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

  // ── Evidence (mirrors sub-score structure, carries the text strings) ─────────
  const evidence = {
    portIn: {
      purpose:          { evidence: portIn.purpose.evidence },
      outcomes:         { evidence: portIn.outcomes.evidence },
      responsibilities: { evidence: portIn.responsibilities.evidence },
      timedAgenda:      { evidence: portIn.timedAgenda.evidence },
    },
    safe: {
      share:      { evidence: safe.share.evidence },
      ask:        { evidence: safe.ask.evidence },
      facilitate: { evidence: safe.facilitate.evidence },
      energise:   { evidence: safe.energise.evidence },
    },
    race: {
      resolve:   { evidence: race.resolve.evidence },
      actioning: { evidence: race.actioning.evidence },
      challenge: { evidence: race.challenge.evidence },
      economise: { evidence: race.economise.evidence },
    },
    portOut: {
      plan:             { evidence: portOut.plan.evidence },
      outcomes:         { evidence: portOut.outcomes.evidence },
      responsibilities: { evidence: portOut.responsibilities.evidence },
      time:             { evidence: portOut.time.evidence },
    },
  };

  // ── Dashboard metrics (weighted composites, raw 0–4 averages → percent) ──────
  //
  // Effective Start       = PORT In (all 4 behaviours)
  // Psychological Safety  = SAFE (all 4 behaviours)
  // Decision Making Quality = RACE (all 4 behaviours)
  // Effective Close       = PORT Out (all 4 behaviours)
  // One Team              = cohesion & mutual trust: SAFE share + facilitate + energise + RACE resolve
  // Clarity               = purposeful intent & clear outcomes: PORT In purpose+outcomes + PORT Out plan+outcomes

  const effectiveStart  = avg(portIn.purpose.score, portIn.outcomes.score, portIn.responsibilities.score, portIn.timedAgenda.score);
  const psychSafety     = avg(safe.share.score, safe.ask.score, safe.facilitate.score, safe.energise.score);
  const decisionQuality = avg(race.resolve.score, race.actioning.score, race.challenge.score, race.economise.score);
  const effectiveClose  = avg(portOut.plan.score, portOut.outcomes.score, portOut.responsibilities.score, portOut.time.score);
  const oneTeam         = avg(safe.share.score, safe.facilitate.score, safe.energise.score, race.resolve.score);
  const clarity         = avg(portIn.purpose.score, portIn.outcomes.score, portOut.plan.score, portOut.outcomes.score);
  const overall         = avg(effectiveStart, psychSafety, decisionQuality, effectiveClose, oneTeam, clarity);

  const scores = {
    dashboard: {
      overall:         dashMetric(overall),
      effectiveStart:  dashMetric(effectiveStart),
      psychSafety:     dashMetric(psychSafety),
      decisionQuality: dashMetric(decisionQuality),
      effectiveClose:  dashMetric(effectiveClose),
      oneTeam:         dashMetric(oneTeam),
      clarity:         dashMetric(clarity),
    },
    subScores,
  };

  return {
    meetingContext:        raw.meetingContext        || '',
    meetingType:           meetingType,
    scores,
    evidence,
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
        model: 'claude-opus-4-5',
        max_tokens: 8000,
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
