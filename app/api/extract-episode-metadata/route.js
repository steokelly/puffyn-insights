import { getSupabaseServerClient } from '../../../lib/supabase';

export const maxDuration = 60;

const MAX_PER_RUN = 5;

const METADATA_SYSTEM_PROMPT = `You are extracting structural metadata from a podcast transcript, not analysing content for insights.

Identify:
1. Presenters/hosts (the regular hosts of the show)
2. Any guests or contributors, with their role or affiliation if it's mentioned (e.g. "Jennifer Bray (Irish Times political reporter)")
3. 2-5 main themes or topics discussed, as short phrases (e.g. "Metrolink cost overruns", "PD party legacy")

If speaker names aren't stated explicitly in the transcript, use "Speaker 0", "Speaker 1" etc as they appear, rather than guessing names.

Respond with ONLY valid JSON, no other text:
{
  "participants": ["Name (role)", "..."],
  "themes": ["theme 1", "theme 2"]
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

  const { data: episodes, error: fetchError } = await supabase
    .from('episodes')
    .select('id, title, transcript_text')
    .is('main_themes', null)
    .not('transcript_text', 'is', null)
    .order('published_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (fetchError) {
    return Response.json({ error: 'Failed to query episodes', detail: fetchError.message }, { status: 500 });
  }

  if (!episodes || episodes.length === 0) {
    return Response.json({ message: 'No episodes need metadata extraction.' });
  }

  const results = [];

  for (const episode of episodes) {
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
          max_tokens: 512,
          system: METADATA_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Transcript:\n${episode.transcript_text}` }],
        }),
      });

      if (!claudeRes.ok) {
        results.push({ title: episode.title, status: 'error', reason: `Claude ${claudeRes.status}` });
        continue;
      }

      const claudeData = await claudeRes.json();
      const textBlock = claudeData?.content?.find((block) => block.type === 'text');
      const rawText = textBlock?.text || '';
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      await supabase
        .from('episodes')
        .update({
          main_themes: parsed.themes || [],
          participants: parsed.participants || [],
        })
        .eq('id', episode.id);

      results.push({ title: episode.title, status: 'updated', themes: parsed.themes });
    } catch (err) {
      results.push({ title: episode.title, status: 'error', reason: String(err) });
    }
  }

  return Response.json({ processed: results.length, results });
}
