// api/evaluate.js
// Periscope — Powered by Team Up
// Serverless evaluation function with Polaris Formula composite scoring

import Anthropic from '@anthropic-ai/sdk';
import { buildPrompt } from '../lib/prompt.js';

export const config = { maxDuration: 60 };

// ─── RAG Thresholds (same for both meeting types) ──────────────────────────
const RAG_RED_MAX   = 39;   // < 40 = Red
const RAG_AMBER_MAX = 70;   // 40–70 = Amber, > 70 = Green

function ragBand(pct) {
  if (pct <= RAG_RED_MAX)   return 'red';
  if (pct <= RAG_AMBER_MAX) return 'amber';
  return 'green';
}

// ─── Convert raw 1–4 score to percentage ───────────────────────────────────
function pct(score) {
  return Math.round((score / 4) * 100);
}

// ─── Calculate all 7 dashboard metrics from 16 raw sub-scores ──────────────
function calcMetrics(aiScores, meetingType) {
  const isIntact = meetingType === 'intact';

  const { portIn: pi, safe: s, race: r, portOut: po } = aiScores;

  // Convert all 16 sub-scores to percentages
  const P_in  = pct(pi.purpose.score);
  const O_in  = pct(pi.outcomes.score);
  const R_in  = pct(pi.responsibilities.score);
  const T_in  = pct(pi.timedAgenda.score);

  const Sh = pct(s.share.score);
  const As = pct(s.ask.score);
  const Fa = pct(s.facilitate.score);
  const En = pct(s.energise.score);

  const Rv = pct(r.resolve.score);
  const Ac = pct(r.actioning.score);
  const Ch = pct(r.challenge.score);
  const Ec = pct(r.economise.score);

  const P_out = pct(po.plan.score);
  const O_out = pct(po.outcomes.score);
  const R_out = pct(po.responsibilities.score);
  const T_out = pct(po.time.score);

  // ── 1. EFFECTIVE START (PORT In) — same weighting for both types ──────────
  // O gets 40%, P/R/T get 20% each
  const effectiveStart = Math.round(
    P_in * 0.20 + O_in * 0.40 + R_in * 0.20 + T_in * 0.20
  );

  // ── 2. PSYCHOLOGICAL SAFETY (SAFE) ────────────────────────────────────────
  // Intact:        A 30%, E 30%, S 20%, F 20%
  // Cross-func:    A 35%, E 35%, S 15%, F 15%
  const psychSafety = isIntact
    ? Math.round(Sh * 0.20 + As * 0.30 + Fa * 0.20 + En * 0.30)
    : Math.round(Sh * 0.15 + As * 0.35 + Fa * 0.15 + En * 0.35);

  // ── 3. DECISION MAKING QUALITY (RACE) ─────────────────────────────────────
  // Intact:        A 30%, C 30%, R 20%, E 20%
  // Cross-func:    R 35%, C 35%, A 15%, E 15%
  const decisionQuality = isIntact
    ? Math.round(Rv * 0.20 + Ac * 0.30 + Ch * 0.30 + Ec * 0.20)
    : Math.round(Rv * 0.35 + Ac * 0.15 + Ch * 0.35 + Ec * 0.15);

  // ── 4. EFFECTIVE CLOSE (PORT Out) ─────────────────────────────────────────
  // Intact:        T 40%, P 25%, R 25%, O 10%
  // Cross-func:    P 30%, R 30%, T 30%, O 10%
  const effectiveClose = isIntact
    ? Math.round(P_out * 0.25 + O_out * 0.10 + R_out * 0.25 + T_out * 0.40)
    : Math.round(P_out * 0.30 + O_out * 0.10 + R_out * 0.30 + T_out * 0.30);

  // ── 5. ONE TEAM (Collectivism / Cohesion) ─────────────────────────────────
  // Internal SAFE blend:  A 45%, E 25%, S 15%, F 15%
  // Internal RACE blend:  A 50%, C 25%, R 15%, E 10%
  // Intact totals:   ES 15%, SAFE-blend 37.5%, RACE-blend 27.5%, EC 20%
  // Cross totals:    ES 20%, SAFE-blend 40%,   RACE-blend 20%,   EC 20%
  const safeBlend = Sh * 0.15 + As * 0.45 + Fa * 0.15 + En * 0.25;
  const raceBlend = Rv * 0.15 + Ac * 0.50 + Ch * 0.25 + Ec * 0.10;

  const oneTeam = isIntact
    ? Math.round(
        effectiveStart * 0.150 +
        safeBlend      * 0.375 +
        raceBlend      * 0.275 +
        effectiveClose * 0.200
      )
    : Math.round(
        effectiveStart * 0.200 +
        safeBlend      * 0.400 +
        raceBlend      * 0.200 +
        effectiveClose * 0.200
      );

  // ── 6. CLARITY ────────────────────────────────────────────────────────────
  // Intact:      ES 25%, C(RACE) 25%, EC 30%, F(SAFE) 7.5%, E(RACE) 7.5%, A(SAFE) 5%
  // Cross-func:  ES 20%, A(SAFE) 25%, EC 25%, C(RACE) 22.5%, F(SAFE) 7.5%
  const clarity = isIntact
    ? Math.round(
        effectiveStart * 0.250 +
        As             * 0.050 +
        Fa             * 0.075 +
        Ch             * 0.250 +
        Ec             * 0.075 +
        effectiveClose * 0.300
      )
    : Math.round(
        effectiveStart * 0.200 +
        As             * 0.250 +
        Fa             * 0.075 +
        Ch             * 0.225 +
        effectiveClose * 0.250
      );

  // ── 7. OVERALL MEETING EFFECTIVENESS ──────────────────────────────────────
  // Intact:      DMQ 35%, EC 25%, ES 20%, PS 20%
  // Cross-func:  PS 32.5%, ES 20%, DMQ 25%, EC 22.5%
  const overall = isIntact
    ? Math.round(
        effectiveStart  * 0.200 +
        psychSafety     * 0.200 +
        decisionQuality * 0.350 +
        effectiveClose  * 0.250
      )
    : Math.round(
        effectiveStart  * 0.200 +
        psychSafety     * 0.325 +
        decisionQuality * 0.250 +
        effectiveClose  * 0.225
      );

  return {
    subScores: {
      portIn:  { purpose: P_in,  outcomes: O_in,  responsibilities: R_in,  timedAgenda: T_in  },
      safe:    { share: Sh,      ask: As,          facilitate: Fa,          energise: En       },
      race:    { resolve: Rv,    actioning: Ac,    challenge: Ch,           economise: Ec      },
      portOut: { plan: P_out,    outcomes: O_out,  responsibilities: R_out, time: T_out        }
    },
    dashboard: {
      effectiveStart,
      psychSafety,
      decisionQuality,
      effectiveClose,
      oneTeam,
      clarity,
      overall
    }
  };
}

// ─── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { transcript, meetingType = 'intact' } = req.body;

  if (!transcript || transcript.trim().length < 50) {
    return res.status(400).json({ error: 'Please provide a meeting transcript of at least a few exchanges.' });
  }

  if (!['intact', 'crossfunctional'].includes(meetingType)) {
    return res.status(400).json({ error: 'Invalid meeting type.' });
  }

  try {
    const client = new Anthropic();

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: buildPrompt(meetingType),
      messages: [
        {
          role: 'user',
          content: `Please analyse the following meeting transcript:\n\n${transcript}`
        }
      ]
    });

    // Extract text content from response
    const rawText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Strip any accidental markdown fences
    const cleanJson = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let aiScores;
    try {
      aiScores = JSON.parse(cleanJson);
    } catch (parseError) {
      console.error('JSON parse error:', parseError, 'Raw text:', rawText.substring(0, 500));
      return res.status(500).json({ error: 'Analysis returned an unexpected format. Please try again.' });
    }

    // Validate required fields
    const required = ['portIn', 'safe', 'race', 'portOut'];
    for (const field of required) {
      if (!aiScores[field]) {
        return res.status(500).json({ error: `Analysis incomplete — missing ${field}. Please try again.` });
      }
    }

    const { subScores, dashboard } = calcMetrics(aiScores, meetingType);

    // Build RAG annotations for all scores
    const ragScores = {
      dashboard: Object.fromEntries(
        Object.entries(dashboard).map(([k, v]) => [k, { score: v, rag: ragBand(v) }])
      ),
      subScores: Object.fromEntries(
        Object.entries(subScores).map(([competency, behaviours]) => [
          competency,
          Object.fromEntries(
            Object.entries(behaviours).map(([behaviour, score]) => [
              behaviour,
              { score, rag: ragBand(score) }
            ])
          )
        ])
      )
    };

    return res.status(200).json({
      meetingContext:  aiScores.meetingContext || '',
      meetingType,
      evidence: {
        portIn:  aiScores.portIn,
        safe:    aiScores.safe,
        race:    aiScores.race,
        portOut: aiScores.portOut
      },
      scores: ragScores,
      redFlags:        aiScores.redFlags        || [],
      recommendations: aiScores.recommendations || []
    });

  } catch (error) {
    console.error('Periscope evaluation error:', {
      message: error.message,
      name: error.name,
      status: error.status,
      stack: error.stack?.substring(0, 500)
    });
    const userMessage = error.status === 401 ? 'API key error — check Anthropic credentials.'
      : error.status === 429 ? 'Rate limit reached — please wait a moment and try again.'
      : error.status === 529 ? 'Anthropic API is temporarily overloaded — please try again shortly.'
      : `Analysis failed: ${error.message || 'unknown error'}`;
    return res.status(500).json({ error: userMessage });
  }
}
