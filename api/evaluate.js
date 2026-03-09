// api/evaluate.js
// Polaris × Meeting Evaluator — Dual-Lens Prototype
// Serverless function for Vercel

import { SYSTEM_PROMPT } from '../lib/prompt.js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { transcript, agenda } = req.body;

  if (!transcript || transcript.trim().length === 0) {
    return res.status(400).json({ error: 'No transcript provided' });
  }

  // Build the user message
  let userMessage = `## MEETING TRANSCRIPT\n\n${transcript}`;
  if (agenda && agenda.trim().length > 0) {
    userMessage += `\n\n## MEETING AGENDA / CONTEXT\n\n${agenda}`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: userMessage }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Anthropic API error:', errorData);
      return res.status(500).json({
        error: 'Evaluation failed',
        detail: errorData.error?.message || 'Unknown API error'
      });
    }

    const data = await response.json();

    // Extract the text content from Claude's response
    const textContent = data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Parse the JSON response
    // Try direct parse first, then try extracting JSON from text
    let evaluation;
    try {
      const cleanJson = textContent
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
      evaluation = JSON.parse(cleanJson);
    } catch (parseError) {
      // Fallback: extract the first complete JSON object
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          evaluation = JSON.parse(jsonMatch[0]);
        } catch (e) {
          console.error('JSON parse error (fallback):', e);
          console.error('Raw response:', textContent.substring(0, 500));
          return res.status(500).json({
            error: 'Failed to parse evaluation',
            detail: 'The AI returned a response that could not be parsed as JSON.'
          });
        }
      } else {
        console.error('No JSON found in response');
        console.error('Raw response:', textContent.substring(0, 500));
        return res.status(500).json({
          error: 'Failed to parse evaluation',
          detail: 'The AI response did not contain valid JSON.'
        });
      }
    }

    // Return the structured evaluation
    return res.status(200).json(evaluation);

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({
      error: 'Server error',
      detail: error.message
    });
  }
}
