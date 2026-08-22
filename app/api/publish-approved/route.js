import { getSupabaseServerClient } from '../../../lib/supabase';

export const maxDuration = 60;

const MAX_PER_RUN = 5;

// Logs into Bluesky using the app password and returns an access token
// plus the account's DID (its unique identifier), both needed to post.
async function getBlueskySession() {
  const res = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifier: process.env.BLUESKY_HANDLE,
      password: process.env.BLUESKY_APP_PASSWORD,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Bluesky login failed: ${res.status} ${detail}`);
  }

  return res.json();
}

async function postToBluesky(session, text) {
  const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Bluesky post failed: ${res.status} ${detail}`);
  }

  return res.json();
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

  const { data: drafts, error: fetchError } = await supabase
    .from('content_drafts')
    .select('id, content')
    .eq('platform', 'bluesky')
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (fetchError) {
    return Response.json({ error: 'Failed to query drafts', detail: fetchError.message }, { status: 500 });
  }

  if (!drafts || drafts.length === 0) {
    return Response.json({ message: 'No approved Bluesky drafts waiting to publish.' });
  }

  let session;
  try {
    session = await getBlueskySession();
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }

  const results = [];

  for (const draft of drafts) {
    try {
      const postResult = await postToBluesky(session, draft.content);
      await supabase
        .from('content_drafts')
        .update({ status: 'published', posted_uri: postResult.uri, posted_at: new Date().toISOString() })
        .eq('id', draft.id);
      results.push({ id: draft.id, status: 'published', uri: postResult.uri });
    } catch (err) {
      results.push({ id: draft.id, status: 'error', reason: String(err) });
    }
  }

  return Response.json({ processed: results.length, results });
}
