// ============================================================
// POLARIS MEETING EVALUATOR — SERVERLESS FUNCTION
// api/evaluate.js
// Vercel serverless function — ES module syntax (export default)
// ============================================================

import { buildPrompt } from '../lib/prompt.js';

// Extend Vercel serverless function timeout to 60 seconds.
// Without this the default is 10s, which Claude routinely exceeds.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Extract transcript and meetingType from request body
  // meetingType: 'intact' (default) | 'crossfunctional'
  const { transcript, meetingType = 'intact' } = req.body;

  // Basic validation
  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 50) {
    return res.status(400).json({
      error: 'Please provide a meeting transcript of at least 50 characters.',
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error. Please contact support.' });
  }

  try {
    // Build the prompt with meeting type context
    const systemPrompt = buildPrompt(meetingType);

    // Call the Anthropic Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Please evaluate the following meeting transcript:\n\n${transcript.trim()}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Anthropic API error:', response.status, errorBody);
      return res.status(502).json({
        error: 'The AI analysis service is temporarily unavailable. Please try again in a moment.',
      });
    }

    const data = await response.json();

    // Extract text content from response
    const rawText = data.content?.[0]?.text;
    if (!rawText) {
      console.error('Unexpected API response shape:', JSON.stringify(data));
      return res.status(500).json({ error: 'Unexpected response from AI. Please try again.' });
    }

    // Strip any accidental markdown fences before parsing
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('JSON parse failed. Raw text:', rawText);
      return res.status(500).json({
        error: 'Could not parse the AI evaluation. Please try again — this is usually a transient issue.',
      });
    }

    // Basic structural validation before returning.
    // Keys match the real prompt schema in lib/prompt.js.
    if (!result.portIn || !result.safe || !result.race || !result.portOut) {
      console.error('Response missing expected top-level keys:', Object.keys(result));
      return res.status(500).json({
        error: 'The AI returned an incomplete evaluation. Please try again.',
      });
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('Unhandled evaluation error:', err);
    return res.status(500).json({
      error: 'An unexpected error occurred. Please try again.',
    });
  }
}
