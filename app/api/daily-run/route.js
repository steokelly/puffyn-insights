import { XMLParser } from 'fast-xml-parser';
import { getSupabaseServerClient } from '../../../lib/supabase';

// Give this extra time since it does three jobs in one run.
export const maxDuration = 300;

const APPLE_PODCAST_ID = '794389685';
const PODCAST_NAME = 'Inside Politics (Irish Times)';

// Safety caps: process at most this many episodes/insights per step per run,
// so a backlog (e.g. after a few missed days) can't make a single run huge.
const MAX_PER_STEP = 5;

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

async function checkFeed(supabase) {
  const results = [];

  const lookupRes = await fetch(`https://itunes.apple.com/lookup?id=${APPLE_PODCAST_ID}&entity=podcast`);
  const lookupData = await lookupRes.json();
  const feedUrl = lookupData?.results?.[0]?.feedUrl;
  if (!feedUrl) {
    return { error: 'Could not resolve feed URL from Apple lookup' };
  }

  const feedRes = await fetch(feedUrl, {
    headers: { 'User-Agent': 'PuffynInsights/0.1 (+https://puffyn.app)' },
  });
  const feedXml = await feedRes.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const feedData = parser.parse(feedXml);
  const rawItems = feedData?.rss?.channel?.item;
  if (!rawItems) return { error: 'RSS feed had no episodes' };
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  const recentItems = items.slice(0, 5);

  for (const item of recentItems) {
    const guid = typeof item.guid === 'object' ? item.guid['#text'] : item.guid;
    const title = item.title;
    const audioUrl = item.enclosure ? item.enclosure['@_url'] : null;
    const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null;
    if (!guid) continue;

    const { data: existing } = await supabase
      .from('episodes')
      .select('id')
      .eq('episode_guid', guid)
      .maybeSingle();

    if (existing) continue;

    const { error: insertError } = await supabase.from('episodes').insert({
      podcast_name: PODCAST_NAME,
      episode_guid: guid,
      title,
      published_at: publishedAt,
      audio_url: audioUrl,
      transcript_status: 'pending',
    });

    if (!insertError) results.push(title);
  }

  return { newEpisodes: results };
}

async function transcribeOne(supabase) {
  const { data: episode } = await supabase
    .from('episodes')
    .select('id, title, audio_url')
    .eq('transcript_status', 'pending')
    .order('published_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!episode) return null;
  if (!episode.audio_url) {
    await supabase.from('episodes').update({ transcript_status: 'error' }).eq('id', episode.id);
    return { title: episode.title, status: 'error', reason: 'no audio_url' };
  }

  const deepgramRes = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&diarize=true&utterances=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: episode.audio_url }),
    }
  );

  if (!deepgramRes.ok) {
    await supabase.from('episodes').update({ transcript_status: 'error' }).eq('id', episode.id);
    return { title: episode.title, status: 'error', reason: `Deepgram ${deepgramRes.status}` };
  }

  const deepgramData = await deepgramRes.json();
  const utterances = deepgramData?.results?.utterances;
  let transcriptText;
  if (utterances && utterances.length > 0) {
    transcriptText = utterances.map((u) => `Speaker ${u.speaker}: ${u.transcript}`).join('\n');
  } else {
    transcriptText = deepgramData?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  }

  if (!transcriptText) {
    await supabase.from('episodes').update({ transcript_status: 'error' }).eq('id', episode.id);
    return { title: episode.title, status: 'error', reason: 'empty transcript' };
  }

  await supabase
    .from('episodes')
    .update({ transcript_text: transcriptText, transcript_status: 'transcribed' })
    .eq('id', episode.id);

  return { title: episode.title, status: 'transcribed' };
}

async function analyzeOne(supabase) {
  const { data: episode } = await supabase
    .from('episodes')
    .select('id, title, transcript_text')
    .eq('transcript_status', 'transcribed')
    .order('published_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!episode) return null;

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
        { role: 'user', content: `Episode title: ${episode.title}\n\nTranscript:\n${episode.transcript_text}` },
      ],
    }),
  });

  if (!claudeRes.ok) {
    await supabase.from('episodes').update({ transcript_status: 'analysis_error' }).eq('id', episode.id);
    return { title: episode.title, status: 'error', reason: `Claude ${claudeRes.status}` };
  }

  const claudeData = await claudeRes.json();
  const textBlock = claudeData?.content?.find((block) => block.type === 'text');
  const rawText = textBlock?.text || '';

  let parsed;
  try {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    await supabase.from('episodes').update({ transcript_status: 'analysis_error' }).eq('id', episode.id);
    return { title: episode.title, status: 'error', reason: 'non-JSON response' };
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
  return { title: episode.title, status: 'analyzed', insightsFound: insights.length };
}

async function generateContentOne(supabase) {
  const { data: strongInsights } = await supabase
    .from('insights')
    .select('id, title, explanation, topic')
    .gte('puffyn_score', CONTENT_THRESHOLD)
    .order('puffyn_score', { ascending: false });

  if (!strongInsights || strongInsights.length === 0) return null;

  const { data: existingDrafts } = await supabase.from('content_drafts').select('insight_id');
  const alreadyDrafted = new Set((existingDrafts || []).map((d) => d.insight_id));
  const insight = strongInsights.find((i) => !alreadyDrafted.has(i.id));

  if (!insight) return null;

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
    return { insightTitle: insight.title, status: 'error', reason: `Claude ${claudeRes.status}` };
  }

  const claudeData = await claudeRes.json();
  const textBlock = claudeData?.content?.find((block) => block.type === 'text');
  const rawText = textBlock?.text || '';

  let parsed;
  try {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { insightTitle: insight.title, status: 'error', reason: 'non-JSON response' };
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

  return { insightTitle: insight.title, status: 'drafted', draftsCreated: drafts.length };
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

  const feedResult = await checkFeed(supabase);

  const transcribed = [];
  for (let i = 0; i < MAX_PER_STEP; i++) {
    const result = await transcribeOne(supabase);
    if (!result) break;
    transcribed.push(result);
  }

  const analyzed = [];
  for (let i = 0; i < MAX_PER_STEP; i++) {
    const result = await analyzeOne(supabase);
    if (!result) break;
    analyzed.push(result);
  }

  const drafted = [];
  for (let i = 0; i < MAX_PER_STEP; i++) {
    const result = await generateContentOne(supabase);
    if (!result) break;
    drafted.push(result);
  }

  return Response.json({
    feedCheck: feedResult,
    transcribed,
    analyzed,
    drafted,
  });
}
