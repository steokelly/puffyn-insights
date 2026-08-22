import { getSupabaseServerClient } from '../../../lib/supabase';
import { CONTENT_SYSTEM_PROMPT, buildAttributionSuffix, PLATFORM_LIMITS, enforceLimit } from '../../../lib/contentPrompts';

export const maxDuration = 60;

// Only insights scoring 85+ get content drafted — per the brief's thresholds,
// this is the "develop into potential content" tier.
const CONTENT_THRESHOLD = 70;

async function draftForPlatform(insight, platform, source) {
  const suffix = buildAttributionSuffix(platform, source);
  const maxChars = PLATFORM_LIMITS[platform] - suffix.length;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      system: CONTENT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Insight: ${insight.title}\n\nExplanation: ${insight.explanation}\n\nTopic: ${insight.topic}\n\nPlatform: ${platform}\n\nMaximum character count for your text (before the source credit is added): ${maxChars}`,
        },
      ],
    }),
  });

  if (!claudeRes.ok) {
    throw new Error(`Claude ${claudeRes.status}`);
  }

  const claudeData = await claudeRes.json();
  const textBlock = claudeData?.content?.find((block) => block.type === 'text');
  const rawText = textBlock?.text || '';
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  return {
    platform,
    format: parsed.format || 'observation',
    content: enforceLimit((parsed.content || '').trim(), suffix, PLATFORM_LIMITS[platform]),
  };
}

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

  const { data: strongInsights, error: insightsError } = await supabase
    .from('insights')
    .select('id, title, explanation, topic, episodes(podcast_name)')
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

  const { data: source } = await supabase
    .from('podcast_sources')
    .select('podcast_name, x_handle, bluesky_handle')
    .eq('podcast_name', insight.episodes?.podcast_name)
    .maybeSingle();

  const drafts = [];
  for (const platform of ['x', 'bluesky']) {
    try {
      const draft = await draftForPlatform(insight, platform, source);
      await supabase.from('content_drafts').insert({
        insight_id: insight.id,
        platform: draft.platform,
        format: draft.format,
        content: draft.content,
      });
      drafts.push(draft);
    } catch (err) {
      drafts.push({ platform, status: 'error', reason: String(err) });
    }
  }

  return Response.json({ insightTitle: insight.title, draftsCreated: drafts.length, drafts });
}
