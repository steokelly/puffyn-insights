import { getSupabaseServerClient } from '../../../lib/supabase';

// Deepgram usually transcribes an hour-long episode in well under a minute,
// but we give this function extra time (Vercel's allowed maximum on the free
// tier) in case a longer episode or a slow response pushes past the default.
export const maxDuration = 60;

// Processes ONE pending episode per call, oldest first. Kept deliberately
// simple for the MVP: no job queue, no batching. If this needs to run for
// many episodes at once later, that's the point to introduce a proper queue.
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

  // Find the oldest episode still waiting to be transcribed.
  const { data: episode, error: fetchError } = await supabase
    .from('episodes')
    .select('id, title, audio_url')
    .eq('transcript_status', 'pending')
    .order('published_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    return Response.json({ error: 'Failed to query episodes', detail: fetchError.message }, { status: 500 });
  }

  if (!episode) {
    return Response.json({ message: 'No pending episodes to transcribe.' });
  }

  if (!episode.audio_url) {
    await supabase
      .from('episodes')
      .update({ transcript_status: 'error' })
      .eq('id', episode.id);
    return Response.json(
      { error: 'Episode has no audio_url, cannot transcribe', title: episode.title },
      { status: 422 }
    );
  }

  try {
    // Deepgram fetches the audio itself from the URL we give it — we never
    // download or hold the audio file in this function, which keeps this
    // fast and avoids memory/size limits entirely.
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
      const errorBody = await deepgramRes.text();
      await supabase.from('episodes').update({ transcript_status: 'error' }).eq('id', episode.id);
      return Response.json(
        { error: 'Deepgram request failed', status: deepgramRes.status, detail: errorBody, title: episode.title },
        { status: 502 }
      );
    }

    const deepgramData = await deepgramRes.json();
    const utterances = deepgramData?.results?.utterances;

    let transcriptText;
    if (utterances && utterances.length > 0) {
      // Build a readable speaker-labeled transcript, e.g. "Speaker 0: ...".
      transcriptText = utterances
        .map((u) => `Speaker ${u.speaker}: ${u.transcript}`)
        .join('\n');
    } else {
      // Fallback: plain transcript with no speaker labels, in case
      // utterances weren't returned for some reason.
      transcriptText = deepgramData?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    }

    if (!transcriptText) {
      await supabase.from('episodes').update({ transcript_status: 'error' }).eq('id', episode.id);
      return Response.json(
        { error: 'Deepgram returned no usable transcript', title: episode.title },
        { status: 502 }
      );
    }

    const { error: updateError } = await supabase
      .from('episodes')
      .update({ transcript_text: transcriptText, transcript_status: 'transcribed' })
      .eq('id', episode.id);

    if (updateError) {
      return Response.json(
        { error: 'Transcription succeeded but saving it failed', detail: updateError.message, title: episode.title },
        { status: 500 }
      );
    }

    return Response.json({
      title: episode.title,
      status: 'transcribed',
      wordCount: transcriptText.split(/\s+/).length,
    });
  } catch (err) {
    await supabase.from('episodes').update({ transcript_status: 'error' }).eq('id', episode.id);
    return Response.json({ error: 'Unexpected failure', detail: String(err), title: episode.title }, { status: 500 });
  }
}
