import { getSupabaseServerClient } from '../../../lib/supabase';

export const maxDuration = 60;

// Only insights scoring 85+ get content drafted — per the brief's thresholds,
// this is the "develop into potential content" tier.
const CONTENT_THRESHOLD = 85;

const CONTENT_SYSTEM_PROMPT = `You write short-form social content for Puffyn, a media brand for the open-minded covering Ireland, culture, politics, and society. Puffyn's voice: curious, intelligent, progressive, open-minded, thoughtful, accessible, willing to challenge conventional thinking, distinctly human. Never generic-AI-sounding, never rage-baiting, never overstating evidence, never emoji-heavy.

You'll be given one research insight. Draft short-form posts inspired by it — never reproduce source material verbatim, never fabricate quotes or statistics beyond what's given.

Choose 1-2 of these formats, whichever suits the insight best (don't force all of them):
- Observation: a concise interesting thought
- Question: an intelligent conversation starter
- Puffyn Take: an original interpretation

Write separate copy for X (concise, under 280 characters) and Bluesky (can be slightly longer and more conversational) — don't just duplicate the same text on both.

Respond with ONLY valid JSON, no other text:
{
  "drafts": [
    { "platform": "x", "format": "observation", "content": "..." },
    { "platform": "bluesky", "format": "observation", "content": "..." }
  ]
}`;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const providedQuerySecret = searchParams.get('secret');
  const authHeader = request.headers.get('authorization');

  const isValidCronRequest =
    process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isValidManualRequest =
    process.env.CHECK_FEED_SECRET && providedQuerySecret === process.env.CHECK_FEED_SECRET;

  if (!isValidCronRequest && !isValidManualRequest) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseServerClient();

  // Find high-scoring insights, then figure out which ones don't have
  // drafts yet (kept simple/explicit for the MVP rather than a fancy join).
  const { data: strongInsights, error: insightsError } = await supabase
    .from('insights')
    .select('id, title, explanation, topic')
    .gte('puffyn_score', CONTENT_THRESHOLD)
    .order('puffyn_score', { ascending: false });

  if (insightsError) {
    return Response.json({ error: 'Failed to query insights', detail: insightsError.message }, { status: 500 });
  }

  if (!strongInsights || strongInsights.length === 0) {
    return Response.json({ message: `No insights scoring ${CONTENT_THRESHOLD}+ yet.` });
  }

  const { data: existingDrafts } = await supabase.from('content_drafts').select('insight_id');
  const alreadyDrafted = new Set((existingDrafts || []).map((d) => d.insight_id));

  const insight = strongInsights.find((i) => !alreadyDrafted.has(i.id));

  if (!insight) {
    return Response.json({ message: 'All high-scoring insights already have drafts.' });
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: CONTENT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Insight: ${insight.title}\n\nExplanation: ${insight.explanation}\n\nTopic: ${insight.topic}`,
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errorBody = await claudeRes.text();
      return Response.json(
        { error: 'Claude request failed', status: claudeRes.status, detail: errorBody, insightTitle: insight.title },
        { status: 502 }
      );
    }

    const claudeData = await claudeRes.json();
    const textBlock = claudeData?.content?.find((block) => block.type === 'text');
    const rawText = textBlock?.text || '';

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return Response.json(
        { error: 'Claude returned non-JSON output', raw: rawText.slice(0, 500), insightTitle: insight.title },
        { status: 502 }
      );
    }

    const drafts = parsed.drafts || [];

    for (const draft of drafts) {
      await supabase.from('content_drafts').insert({
        insight_id: insight.id,
        platform: draft.platform,
        format: draft.format,
        content: draft.content,
      });
    }

    return Response.json({
      insightTitle: insight.title,
      draftsCreated: drafts.length,
      drafts,
    });
  } catch (err) {
    return Response.json({ error: 'Unexpected failure', detail: String(err), insightTitle: insight.title }, { status: 500 });
  }
}
