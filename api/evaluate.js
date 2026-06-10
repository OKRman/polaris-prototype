export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { transcript, agenda, meetingType, costData } = req.body;

  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: "Transcript is required" });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const RESEND_API_KEY    = process.env.RESEND_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "API key not configured" });
  }

  // ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
  const SYSTEM_PROMPT = `You are an expert meeting effectiveness evaluator and behavioural coach. You evaluate meetings across THREE complementary frameworks and return a single combined JSON response.

FRAMEWORK 1: MEETING EFFECTIVENESS (20-point research framework)
Based on the research of Rogelberg, Lencioni, Edmondson, and Meyer. Score each dimension 0-4.

DIMENSIONS:
1. PURPOSE & STRUCTURE (0-4): Clarity of purpose, Lencioni meeting taxonomy, agenda quality, time discipline, stakes framing.
2. PARTICIPATION & INCLUSION (0-4): Balance of speaking time, all voices heard, Bezos two-pizza rule (5-8 optimal).
3. QUALITY OF DIALOGUE (0-4): Productive conflict vs artificial harmony, mining for conflict, depth of analysis, ideas stress-tested.
4. DECISIONS & OUTCOMES (0-4): Clear decisions with rationale, named owners, deadlines, review of prior commitments, disagree-and-commit.
5. LEADERSHIP & CULTURE (0-4): Leader as steward of time, speaks last, models vulnerability, mines for conflict, psychological safety signals.

CLASSIFICATION BANDS: 17-20 Exemplary, 13-16 Effective, 9-12 Mediocre, 5-8 Dysfunctional, 0-4 Toxic.

Trace low scores using Lencioni's Five Dysfunctions (Absence of Trust, Fear of Conflict, Lack of Commitment, Avoidance of Accountability, Inattention to Results).

FRAMEWORK 2: CRAFT BEHAVIOURAL FRAMEWORK (25-point coaching lens)
Proprietary framework. Score each principle 1-5. (1=No evidence, 2=Weak, 3=Partial, 4=Strong, 5=Exemplary)

C-CLARITY: Purpose stated upfront; agenda with allocations; decision criteria explicit; context shared before discussion; roles named. WARNING: No purpose; drift; vague success criteria; different assumptions.
R-RESPONSIBILITY: Clear owner named; proactive volunteering; owner present; prior accountability tracked; active voice commitments. WARNING: Actions to absent people; passive voice; no volunteering; prior actions unreviewed.
A-ACTION (Decision Quality): Decision type understood; explicit decision reached; decision-maker identified; healthy debate then commitment; documented rationale. WARNING: No decision; deferred to absent colleague; consensus replaces decisiveness.
F-FOCUS (Engagement): Multiple voices heard; dissent invited; right people in room; feedback given constructively; psychological safety; cross-functional perspectives integrated. WARNING: One/two voices dominate; silent participants; key people absent; blame language.
T-TEMPO (Structure): Consistent format; cadence respected; decisions logged; connections to broader goals; meeting type appropriate. WARNING: Ad hoc agenda; overrun; no record; disconnect from context; should have been async.

FRAMEWORK 3: ZONE INDICATOR (Learning vs Performing Zone)
Based on Peter Kerr's Learning/Performing Zone model and David Marquet's Red/Blue language distinction.

RED LANGUAGE (Performing Zone): Declarative certainty ("The answer is...", "We need to..."); position defence without invitation to challenge; rhetorical questions; absence of "I don't know"; status-protective language.
BLUE LANGUAGE (Learning Zone): Genuine inquiry ("What am I missing?", "Help me understand..."); explicit uncertainty ("I'm not sure...", "I might be wrong..."); building language ("Building on what X said..."); invitations to challenge; real-time view-updating.

ZONE READINGS: Learning Zone Dominant (blue outnumbers red; genuine inquiry; uncertainty named; challenge invited), Mixed Zone (both present; pockets of inquiry), Performing Zone Dominant (red dominates; no uncertainty named; challenge absent or deflected).

Use coaching language throughout. Frame as observation, not verdict.

RESPOND IN VALID JSON ONLY. No markdown, no backticks, no preamble.

{
  "meeting_type": "Daily Check-In|Weekly Tactical|Monthly Strategic|Quarterly Off-Site|Other/Unclear",
  "dimensions": [
    { "name": "Purpose & Structure", "score": <0-4>, "evidence": "<specific>", "gap": "<improvement>" },
    { "name": "Participation & Inclusion", "score": <0-4>, "evidence": "<specific>", "gap": "<improvement>" },
    { "name": "Quality of Dialogue", "score": <0-4>, "evidence": "<specific>", "gap": "<improvement>" },
    { "name": "Decisions & Outcomes", "score": <0-4>, "evidence": "<specific>", "gap": "<improvement>" },
    { "name": "Leadership & Culture", "score": <0-4>, "evidence": "<specific>", "gap": "<improvement>" }
  ],
  "total_score": <0-20>,
  "classification": "Exemplary|Effective|Mediocre|Dysfunctional|Toxic",
  "root_cause_diagnosis": "<2-3 sentences using Lencioni's model>",
  "top_strength": "<single most impressive aspect>",
  "priority_intervention": "<single most impactful change, framed as capability to build>",
  "cultural_note": "<cultural dynamics observation>",
  "craft": {
    "confidence": "High|Medium|Low",
    "confidence_note": "<one sentence on transcript depth>",
    "total_score": <5-25>,
    "principles": [
      { "letter": "C", "name": "Clarity",       "score": <1-5>, "evidence": "<coaching obs>", "gap": "<developmental prompt>", "technique": "<technique name>" },
      { "letter": "R", "name": "Responsibility", "score": <1-5>, "evidence": "<coaching obs>", "gap": "<developmental prompt>", "technique": "<technique name>" },
      { "letter": "A", "name": "Action",         "score": <1-5>, "evidence": "<coaching obs>", "gap": "<developmental prompt>", "technique": "<technique name>" },
      { "letter": "F", "name": "Focus",          "score": <1-5>, "evidence": "<coaching obs>", "gap": "<developmental prompt>", "technique": "<technique name>" },
      { "letter": "T", "name": "Tempo",          "score": <1-5>, "evidence": "<coaching obs>", "gap": "<developmental prompt>", "technique": "<technique name>" }
    ],
    "craft_headline": "<single coaching observation>",
    "priority_craft_principle": "<highest leverage principle and why>"
  },
  "zone_indicator": {
    "reading": "Learning Zone Dominant|Mixed Zone|Performing Zone Dominant",
    "red_signals_detected": <number>,
    "blue_signals_detected": <number>,
    "dominant_pattern": "<brief phrase>",
    "red_evidence": "<specific quote or paraphrase>",
    "blue_evidence": "<specific quote or paraphrase>",
    "zone_coaching_note": "<2-3 sentence coaching observation>",
    "zone_shift_prompt": "<single most impactful habit>",
    "participant_zone_map": [
      { "participant": "<name or role>", "zone": "Learning|Mixed|Performing", "note": "<brief>" }
    ]
  }
}`;

  const meetingTypeLabel = meetingType === 'cross-functional' ? 'Cross-Functional' : 'Team Meeting';
const userMsg = `MEETING TYPE (as selected by user): ${meetingTypeLabel}\nMEETING AGENDA:\n${agenda || "No agenda provided"}\n\nTRANSCRIPT:\n${transcript}`;

  // ── AI EVALUATION ──────────────────────────────────────────────────────────
  let parsed;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 5000,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      return res.status(502).json({ error: "Evaluation service temporarily unavailable" });
    }

    const data   = await response.json();
    const text   = data.content?.map((b) => b.text || "").join("") || "";
    const clean  = text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error("Evaluation error:", err);
    return res.status(500).json({ error: "Failed to evaluate meeting" });
  }

  // ── COACH EMAIL — awaited before response so Vercel doesn't kill it early ──
  // Fire-and-forget does NOT work on Vercel serverless: the function freezes
  // the moment res.json() is called, before any unawaited promises complete.
  // Awaiting here adds ~300ms to the user response — imperceptible in practice.
  if (RESEND_API_KEY) {
    try {
      await sendCoachEmail(parsed, transcript, agenda, RESEND_API_KEY, costData, meetingType);
    } catch (e) {
      console.error("[CoachEmail] FAILED:", e?.message || e);
      // Don't block the user response on email failure
    }
  } else {
    console.warn("[CoachEmail] RESEND_API_KEY not set — add to Vercel env vars.");
  }

  // ── PUBLIC RESPONSE — scores only, no evidence/analysis ───────────────────
  return res.status(200).json({
    meeting_type:   parsed.meeting_type,
    total_score:    parsed.total_score,
    classification: parsed.classification,
    dimensions: parsed.dimensions.map(d => ({
      name:  d.name,
      score: d.score,
    })),
    top_strength: parsed.top_strength,
    craft: {
      total_score: parsed.craft?.total_score,
      confidence:  parsed.craft?.confidence,
      principles:  parsed.craft?.principles?.map(p => ({
        letter: p.letter,
        name:   p.name,
        score:  p.score,
      })),
    },
    zone_indicator: {
      reading:          parsed.zone_indicator?.reading,
      dominant_pattern: parsed.zone_indicator?.dominant_pattern,
    },
  });
}

// ── COACH EMAIL ────────────────────────────────────────────────────────────────
async function sendCoachEmail(data, transcript, agenda, apiKey, costData, meetingType) {
  const d    = data;
  const date = new Date().toLocaleDateString("en-GB", { day:"numeric", month:"long", year:"numeric" });
  const time = new Date().toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" });

  const sc = (s, max) => { const p=s/max; return p>=0.8?"#15803d":p>=0.6?"#c8820a":p>=0.4?"#b45309":"#c0392b"; };
  const bg = (s, max) => { const p=s/max; return p>=0.8?"#dcfce7":p>=0.6?"#fef3c7":p>=0.4?"#fff7ed":"#fee2e2"; };

  const zoneColor = d.zone_indicator?.reading?.includes("Learning") ? "#15803d"
                  : d.zone_indicator?.reading?.includes("Mixed")    ? "#b45309" : "#c0392b";
  const zoneBg    = d.zone_indicator?.reading?.includes("Learning") ? "#dcfce7"
                  : d.zone_indicator?.reading?.includes("Mixed")    ? "#fef3c7" : "#fee2e2";

  const dimRows = (d.dimensions || []).map(dim => `
    <tr>
      <td style="padding:10px 14px;font-weight:600;border-bottom:1px solid #e8e3d8;font-size:13px;">${dim.name}</td>
      <td style="padding:10px 14px;text-align:center;border-bottom:1px solid #e8e3d8;">
        <span style="background:${bg(dim.score,4)};color:${sc(dim.score,4)};font-weight:700;padding:3px 12px;border-radius:20px;font-size:13px;">${dim.score}/4</span>
      </td>
      <td style="padding:10px 14px;font-size:13px;color:#5a5550;border-bottom:1px solid #e8e3d8;">${dim.evidence||"—"}</td>
      <td style="padding:10px 14px;font-size:13px;color:#c8820a;border-bottom:1px solid #e8e3d8;">${dim.gap||"—"}</td>
    </tr>`).join("");

  const craftRows = (d.craft?.principles || []).map(p => `
    <tr>
      <td style="padding:10px 14px;font-weight:700;border-bottom:1px solid #e8e3d8;font-size:13px;">${p.letter} — ${p.name}</td>
      <td style="padding:10px 14px;text-align:center;border-bottom:1px solid #e8e3d8;">
        <span style="background:${bg(p.score,5)};color:${sc(p.score,5)};font-weight:700;padding:3px 12px;border-radius:20px;font-size:13px;">${p.score}/5</span>
      </td>
      <td style="padding:10px 14px;font-size:13px;color:#5a5550;border-bottom:1px solid #e8e3d8;">${p.evidence||"—"}</td>
      <td style="padding:10px 14px;font-size:13px;color:#c8820a;border-bottom:1px solid #e8e3d8;">${p.gap||"—"}</td>
      <td style="padding:10px 14px;font-size:13px;color:#7d1054;font-weight:600;border-bottom:1px solid #e8e3d8;">${p.technique||"—"}</td>
    </tr>`).join("");

  const participantRows = (d.zone_indicator?.participant_zone_map || []).length
    ? d.zone_indicator.participant_zone_map.map(pm => {
        const c = pm.zone==="Learning"?"#15803d":pm.zone==="Mixed"?"#b45309":"#c0392b";
        return `<tr>
          <td style="padding:8px 14px;font-size:13px;border-bottom:1px solid #e8e3d8;">${pm.participant}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #e8e3d8;"><span style="color:${c};font-weight:700;font-size:13px;">${pm.zone}</span></td>
          <td style="padding:8px 14px;font-size:13px;color:#5a5550;border-bottom:1px solid #e8e3d8;">${pm.note||"—"}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="3" style="padding:10px 14px;color:#8a857e;font-size:13px;">Participant names not detected in transcript</td></tr>`;

  const costEmailSec = costData ? `
    <div style="margin-bottom:24px;">
      <div style="font-size:10px;font-weight:700;color:#c8820a;text-transform:uppercase;letter-spacing:0.18em;margin-bottom:10px;">Meeting Investment &amp; Return</div>
      <div style="background:#111;border-radius:12px;padding:22px 26px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#c8820a,transparent 60%);"></div>
        <div style="font-family:Georgia,serif;font-size:44px;font-weight:700;color:#fff;line-height:1;letter-spacing:-0.02em;margin-bottom:4px;">\xa3${Math.round(costData.total).toLocaleString('en-GB')}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.65);margin-bottom:16px;">${costData.a} attendees &middot; ${costData.m} min${costData.p > 0 ? ` + ${costData.p}min prep` : ''} &middot; avg ${costData.sl}</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
          <tr>
            <td width="48%" style="background:#1e1e1e;border-radius:8px;padding:12px 14px;border:1px solid #333;">
              <div style="font-size:11px;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px;">If weekly (annual)</div>
              <div style="font-family:'Courier New',monospace;font-size:20px;font-weight:600;color:#fff;">\xa3${Math.round(costData.weekly52).toLocaleString('en-GB')}</div>
            </td>
            <td width="4%"></td>
            <td width="48%" style="background:#1e1e1e;border-radius:8px;padding:12px 14px;border:1px solid #333;">
              <div style="font-size:11px;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px;">Estimated value lost</div>
              <div style="font-family:'Courier New',monospace;font-size:20px;font-weight:600;color:#f87171;">\xa3${Math.round(costData.total * (1 - d.total_score/20)).toLocaleString('en-GB')}</div>
            </td>
          </tr>
        </table>
        <div style="font-size:12px;color:rgba(255,255,255,0.4);line-height:1.6;">Score of ${d.total_score}/20 &middot; ${Math.round((1 - d.total_score/20)*100)}% of meeting cost is unrealised potential &middot; 1.3&times; overhead multiplier applied</div>
      </div>
    </div>` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f0ea;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;background:#f3f0ea;">
<tr><td align="center">
<table width="700" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e8e3d8;">

  <tr><td style="background:#0a0a0a;padding:28px 36px;border-bottom:3px solid #c8820a;">
    <div style="font-size:10px;font-weight:700;color:#c8820a;text-transform:uppercase;letter-spacing:0.2em;margin-bottom:6px;">Earn the Right · Private Coach Report</div>
    <div style="font-size:22px;font-weight:700;color:#fff;font-family:Georgia,serif;">Full Meeting Evaluation</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:6px;">${date} at ${time} · ${d.meeting_type} · ${meetingType === 'cross-functional' ? 'Cross-Functional' : 'Team Meeting'}</div>
  </td></tr>

  <tr><td style="padding:28px 36px 20px;">
    <div style="text-align:center;padding:28px;background:${bg(d.total_score,20)};border-radius:12px;border:2px solid ${sc(d.total_score,20)}40;margin-bottom:24px;">
      <div style="font-size:64px;font-weight:700;color:${sc(d.total_score,20)};line-height:1;font-family:Georgia,serif;">${d.total_score}<span style="font-size:24px;font-weight:400;color:#8a857e;">/20</span></div>
      <div style="font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:${sc(d.total_score,20)};margin-top:8px;">${d.classification}</div>
    </div>


    ${costEmailSec}

    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e3d8;border-radius:10px;overflow:hidden;margin-bottom:24px;">
      <thead><tr style="background:#0a0a0a;">
        <th style="padding:10px 14px;text-align:left;color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;">Dimension</th>
        <th style="padding:10px 14px;text-align:center;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Score</th>
        <th style="padding:10px 14px;text-align:left;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Evidence</th>
        <th style="padding:10px 14px;text-align:left;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Gap</th>
      </tr></thead>
      <tbody>${dimRows}</tbody>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr>
        <td style="padding:14px 16px;background:#dcfce7;border-radius:10px;border-left:3px solid #15803d;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">★ Top Strength</div>
          <div style="font-size:13px;line-height:1.65;">${d.top_strength}</div>
        </td>
      </tr>
    </table>
    <div style="height:8px;"></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr>
        <td style="padding:14px 16px;background:#fef3c7;border-radius:10px;border-left:3px solid #b45309;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">◈ Root Cause Diagnosis</div>
          <div style="font-size:13px;line-height:1.65;">${d.root_cause_diagnosis}</div>
        </td>
      </tr>
    </table>
    <div style="height:8px;"></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding:14px 16px;background:#fce8f3;border-radius:10px;border-left:3px solid #b8187a;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;color:#b8187a;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">◆ Priority Intervention</div>
          <div style="font-size:13px;line-height:1.65;">${d.priority_intervention}</div>
        </td>
      </tr>
    </table>
    ${d.cultural_note ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;"><tr><td style="padding:14px 16px;background:#f3f0ea;border-radius:10px;border-left:3px solid #8a857e;vertical-align:top;"><div style="font-size:10px;font-weight:700;color:#8a857e;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">◎ Cultural Note</div><div style="font-size:13px;line-height:1.65;">${d.cultural_note}</div></td></tr></table>` : ""}

    <div style="background:#0a0a0a;border-radius:12px;padding:22px 26px;margin-bottom:16px;border-top:2px solid #c8820a;">
      <div style="font-size:10px;font-weight:700;color:#c8820a;text-transform:uppercase;letter-spacing:0.18em;margin-bottom:8px;">CRAFT Behavioural Framework</div>
      <div style="font-size:42px;font-weight:700;color:#e09b14;font-family:Georgia,serif;line-height:1;display:inline;">${d.craft?.total_score}</div>
      <span style="font-size:16px;color:rgba(255,255,255,0.35);">/25</span>
      <span style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.12em;margin-left:10px;">${d.craft?.confidence} Confidence</span>
      <div style="font-size:13px;color:rgba(255,255,255,0.8);line-height:1.6;margin:12px 0 10px;">${d.craft?.craft_headline}</div>
      <div style="font-size:10px;font-weight:700;color:#c8820a;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">↳ Priority Principle</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.6);line-height:1.6;">${d.craft?.priority_craft_principle}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e3d8;border-radius:10px;overflow:hidden;margin-bottom:24px;">
      <thead><tr style="background:#0a0a0a;">
        <th style="padding:10px 14px;text-align:left;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Principle</th>
        <th style="padding:10px 14px;text-align:center;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Score</th>
        <th style="padding:10px 14px;text-align:left;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Evidence</th>
        <th style="padding:10px 14px;text-align:left;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Development</th>
        <th style="padding:10px 14px;text-align:left;color:#c8820a;font-size:11px;font-weight:700;letter-spacing:0.1em;">Try This</th>
      </tr></thead>
      <tbody>${craftRows}</tbody>
    </table>

    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#8a857e;margin-bottom:10px;">Zone Indicator — Learning vs Performing</div>
    <div style="padding:18px 20px;background:${zoneBg};border-radius:10px;border-left:4px solid ${zoneColor};margin-bottom:12px;">
      <div style="font-size:10px;font-weight:700;color:${zoneColor};text-transform:uppercase;letter-spacing:0.12em;margin-bottom:6px;">Zone Reading</div>
      <div style="font-size:17px;font-weight:700;color:${zoneColor};font-family:Georgia,serif;margin-bottom:4px;">${d.zone_indicator?.reading}</div>
      <div style="font-size:13px;color:#5a5550;">${d.zone_indicator?.dominant_pattern}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
      <tr>
        <td width="49%" style="padding:12px 14px;background:#fee2e2;border-radius:8px;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;color:#c0392b;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">🔴 Red Language Detected</div>
          <div style="font-size:13px;color:#5a5550;line-height:1.6;">${d.zone_indicator?.red_evidence||"—"}</div>
        </td>
        <td width="2%"></td>
        <td width="49%" style="padding:12px 14px;background:#dbeafe;border-radius:8px;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">🔵 Blue Language Detected</div>
          <div style="font-size:13px;color:#5a5550;line-height:1.6;">${d.zone_indicator?.blue_evidence||"—"}</div>
        </td>
      </tr>
    </table>
    <div style="padding:14px 16px;background:#f3f0ea;border-radius:8px;margin-bottom:8px;">
      <div style="font-size:10px;font-weight:700;color:#8a857e;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">Coaching Note</div>
      <div style="font-size:13px;line-height:1.65;">${d.zone_indicator?.zone_coaching_note||"—"}</div>
    </div>
    <div style="padding:14px 16px;background:#fce8f3;border-radius:8px;margin-bottom:16px;">
      <div style="font-size:10px;font-weight:700;color:#b8187a;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">↳ Zone Shift Prompt</div>
      <div style="font-size:13px;line-height:1.65;">${d.zone_indicator?.zone_shift_prompt||"—"}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e3d8;border-radius:10px;overflow:hidden;margin-bottom:24px;">
      <thead><tr style="background:#0a0a0a;">
        <th style="padding:9px 14px;text-align:left;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Participant</th>
        <th style="padding:9px 14px;text-align:left;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Zone</th>
        <th style="padding:9px 14px;text-align:left;color:#fff;font-size:11px;font-weight:700;letter-spacing:0.1em;">Note</th>
      </tr></thead>
      <tbody>${participantRows}</tbody>
    </table>

    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#8a857e;margin-bottom:8px;">Transcript Excerpt (first 600 chars)</div>
    <div style="padding:14px;background:#f3f0ea;border-radius:8px;font-family:'Courier New',monospace;font-size:12px;color:#5a5550;line-height:1.65;border:1px solid #e8e3d8;margin-bottom:24px;">${(transcript||"").slice(0,600).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}${(transcript||"").length>600?"…":""}</div>
  </td></tr>

  <tr><td style="padding:18px 36px;background:#f3f0ea;border-top:1px solid #e8e3d8;text-align:center;">
    <div style="font-size:11px;color:#8a857e;line-height:1.7;">
      Private coach report — the user received scores only.<br>All evidence, diagnosis, CRAFT detail, and zone analysis is visible here only.<br><br>
      <a href="https://www.earntheright.uk/set-up-a-meeting" style="color:#b8187a;font-weight:700;text-decoration:none;">earntheright.uk/set-up-a-meeting</a>
    </div>
  </td></tr>

</table></td></tr></table>
</body></html>`;

  // FROM ADDRESS NOTE:
  // onboarding@resend.dev can only deliver to the email that owns the Resend account.
  // To send to peter.kerr@earntheright.uk from any sender, earntheright.uk must be
  // a verified domain in Resend (Domains tab → Add Domain → add two DNS records).
  // Once verified, change fromAddress to: "Meeting Evaluator <noreply@earntheright.uk>"
  //
  // CURRENT: using onboarding@resend.dev — works if peter.kerr@earntheright.uk is
  // the Resend account email. If not, use the verified domain approach above.
  const fromAddress = "Meeting Evaluator <onboarding@resend.dev>";

  const payload = {
    from:     fromAddress,
    to:       ["peter.kerr@earntheright.uk"],
    reply_to: "peter.kerr@earntheright.uk",
    subject:  `Coach Report · ${d.classification} · ${d.total_score}/20 · CRAFT ${d.craft?.total_score}/25 · ${d.zone_indicator?.reading} · ${date}`,
    html,
  };

  console.log("[CoachEmail] Sending to peter.kerr@earntheright.uk via Resend...");
  console.log("[CoachEmail] From:", fromAddress);
  console.log("[CoachEmail] Subject:", payload.subject);

  const resendResp = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });

  const resendBody = await resendResp.text().catch(() => "(unreadable)");
  console.log("[CoachEmail] Resend HTTP status:", resendResp.status);
  console.log("[CoachEmail] Resend response:", resendBody);

  if (!resendResp.ok) {
    throw new Error(`Resend API returned ${resendResp.status}: ${resendBody}`);
  }

  const resendData = JSON.parse(resendBody).catch ? {} : (JSON.parse(resendBody) || {});
  console.log("[CoachEmail] Sent successfully. Resend ID:", resendData?.id || "(unknown)");
}
