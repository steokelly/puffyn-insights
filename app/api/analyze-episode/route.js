import { getSupabaseServerClient } from '../../../lib/supabase';

export const maxDuration = 60;

const PUFFYN_SYSTEM_PROMPT = `You are the Puffyn Research Editor, analysing a podcast transcript to find genuinely interesting, well-evidenced ideas — not to summarise the episode.

Puffyn's editorial personality: curious, intelligent, progressive, open-minded, culturally aware, thoughtful, accessible, willing to challenge conventional thinking, interested in nuance, distinctly human. Never generic-AI-sounding, never rage-baiting, never manufacturing controversy, never overstating evidence.

Ignore: advertisements, sponsorship reads, introductions, housekeeping, repetitive discussion, promotional filler, low-value small talk.

Look for: central arguments, surprising observations, counterintuitive ideas, strong statistics, interesting claims, disagreements, counterarguments, cultural/political/economic implications, Irish relevance, generational relevance, international comparisons, interesting quotations, potential angles for original Puffyn commentary.

For each genuinely strong insight you find (usually 2-5 per episode, sometimes fewer — do not pad the list with weak material), score it on these dimensions from 0-100:
- interesting: would a smart, curious person want to know this?
- relevant: does it matter beyond this one conversation?
- original: is this a distinctive angle, not an obvious take?
- shareable: could this become a compelling short-form post?
- puffyn_fit: does it match Puffyn's editorial personality and interests?
- evidence_strength: how well-supported is the underlying claim?
- confidence: how confident are you in this assessment?

Then compute an overall puffyn_score (0-100) as your holistic judgment (not simply an average).

Respond with ONLY valid JSON, no other text, in this exact shape:
{
  "insights": [
    {
      "title": "short descriptive title",
      "explanation": "2-4 sentences explaining the insight and why it matters, in Puffyn's voice",
      "topic": "one short topic label, e.g. Irish Politics",
      "tags": ["tag1", "tag2"],
      "interesting_score": 0,
      "relevant_score": 0,
      "original_score": 0,
      "shareable_score": 0,
      "puffyn_fit_score": 0,
      "evidence_strength_score": 0,
      "confidence_score": 0,
      "puffyn_score": 0
    }
  ]
}

If the transcript genuinely contains nothing worth flagging, return {"insights": []}. Do not force insights that aren't there.`;

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

  const { data: episode, error: fetchError } = await supabase
    .from('episodes')
    .select('id, title, transcript_text')
    .eq('transcript_status', 'transcribed')
    .order('published_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    return Response.json({ error: 'Failed to query episodes', detail: fetchError.message }, { status: 500 });
  }

  if (!episode) {
    return Response.json({ message: 'No transcribed episodes waiting for analysis.' });
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
        max_tokens: 4096,
        system: PUFFYN_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Episode title: ${episode.title}\n\nTranscript:\n${episode.transcript_text}`,
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errorBody = await claudeRes.text();
      await supabase.from('episodes').update({ transcript_status: 'analysis_error' }).eq('id', episode.id);
      return Response.json(
        { error: 'Claude request failed', status: claudeRes.status, detail: errorBody, title: episode.title },
        { status: 502 }
      );
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData?.content?.[0]?.text || '';

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      await supabase.from('episodes').update({ transcript_status: 'analysis_error' }).eq('id', episode.id);
      return Response.json(
        { error: 'Claude returned non-JSON output', raw: rawText.slice(0, 500), title: episode.title },
        { status: 502 }
      );
    }

    const insights = parsed.insights || [];

    for (const insight of insights) {
      await supabase.from('insights').insert({
        episode_id: episode.id,
        title: insight.title,
        explanation: insight.explanation,
        topic: insight.topic,
        tags: insight.tags,
        interesting_score: insight.interesting_score,
        relevant_score: insight.relevant_score,
        original_score: insight.original_score,
        shareable_score: insight.shareable_score,
        puffyn_fit_score: insight.puffyn_fit_score,
        evidence_strength_score: insight.evidence_strength_score,
        confidence_score: insight.confidence_score,
        puffyn_score: insight.puffyn_score,
      });
    }

    await supabase.from('episodes').update({ transcript_status: 'analyzed' }).eq('id', episode.id);

    return Response.json({
      title: episode.title,
      status: 'analyzed',
      insightsFound: insights.length,
      insights: insights.map((i) => ({ title: i.title, puffyn_score: i.puffyn_score })),
    });
  } catch (err) {
    await supabase.from('episodes').update({ transcript_status: 'analysis_error' }).eq('id', episode.id);
    return Response.json({ error: 'Unexpected failure', detail: String(err), title: episode.title }, { status: 500 });
  }
}
