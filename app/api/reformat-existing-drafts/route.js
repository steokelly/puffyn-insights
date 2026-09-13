import { getSupabaseServerClient } from '../../../lib/supabase';
import { CONTENT_SYSTEM_PROMPT, PLATFORM_LIMITS, COPY_TARGET, buildSourceLine, composePost } from '../../../lib/contentPrompts';

export const maxDuration = 300;

// How many drafts to process in a single call. If there are more than this
// waiting, just visit the same URL again — already-fixed drafts are
// automatically skipped, so nothing gets duplicated or redone.
const MAX_PER_RUN = 40;

async function rewriteCopy(insight, platform) {
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
          content: `Insight: ${insight.title}\n\nExplanation: ${insight.explanation}\n\nTopic: ${insight.topic}\n\nPlatform: ${platform}\n\nMaximum character count for your text (before the source credit is added): ${COPY_TARGET}`,
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
  return parsed.content || '';
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

  // Only touch drafts still sitting in the review queue. Anything already
  // approved/rejected/published is left alone deliberately.
  const { data: drafts, error: fetchError } = await supabase
    .from('content_drafts')
    .select('id, platform, content, insights(title, explanation, topic, episodes(title, podcast_name))')
    .eq('status', 'pending_review')
    .order('created_at', { ascending: true })
    .limit(200);

  if (fetchError) {
    return Response.json({ error: 'Failed to query drafts', detail: fetchError.message }, { status: 500 });
  }

  if (!drafts || drafts.length === 0) {
    return Response.json({ message: 'No pending drafts to reformat.' });
  }

  let processed = 0;
  let skipped = 0;
  const results = [];

  for (const draft of drafts) {
    if (processed >= MAX_PER_RUN) break;

    const episodeTitle = draft.insights?.episodes?.title;
    const podcastName = draft.insights?.episodes?.podcast_name;
    const sourceLine = buildSourceLine(episodeTitle, podcastName);

    // Already in the new format (ends with the correct source line)? Skip
    // it, so re-running this endpoint never redoes finished work.
    if (draft.content && draft.content.endsWith(`\n\n${sourceLine}`)) {
      skipped++;
      continue;
    }

    if (!draft.insights) {
      results.push({ id: draft.id, status: 'error', reason: 'no linked insight found' });
      processed++;
      continue;
    }

    try {
      const newCopy = await rewriteCopy(draft.insights, draft.platform);
      const finalContent = composePost(newCopy, sourceLine, PLATFORM_LIMITS[draft.platform]);
      await supabase.from('content_drafts').update({ content: finalContent }).eq('id', draft.id);
      results.push({ id: draft.id, status: 'updated' });
    } catch (err) {
      results.push({ id: draft.id, status: 'error', reason: String(err) });
    }

    processed++;
  }

  return Response.json({
    totalPendingFound: drafts.length,
    processedThisRun: processed,
    alreadyCorrectSkipped: skipped,
    remainingAfterThisRun: Math.max(0, drafts.length - processed - skipped),
    results,
  });
}
