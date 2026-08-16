import { XMLParser } from 'fast-xml-parser';
import { getSupabaseServerClient } from '../../../lib/supabase';

// Apple Podcasts ID for "Inside Politics with Hugh Linehan" (The Irish Times).
// We look this up via Apple's public, free iTunes Lookup API rather than
// hardcoding the RSS feed URL directly, because publishers occasionally
// migrate hosting providers and the feed URL can change under the hood.
const APPLE_PODCAST_ID = '794389685';
const PODCAST_NAME = 'Inside Politics (Irish Times)';

export async function GET(request) {
  // Two ways to authenticate this endpoint:
  // 1. Vercel's own Cron system automatically sends "Authorization: Bearer <CRON_SECRET>"
  //    when it triggers this route on a schedule. This is the standard, recommended
  //    way to secure Vercel cron endpoints and requires no secret in any URL or file.
  // 2. A manual "?secret=..." query param, kept only so we can trigger this by hand
  //    from a browser for testing, using the CHECK_FEED_SECRET value.
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

  try {
    // Step 1: resolve the current RSS feed URL from Apple's lookup API.
    const lookupRes = await fetch(
      `https://itunes.apple.com/lookup?id=${APPLE_PODCAST_ID}&entity=podcast`
    );
    const lookupData = await lookupRes.json();

    if (!lookupData.results || lookupData.results.length === 0) {
      return Response.json(
        { error: 'Could not find podcast via Apple lookup', appleId: APPLE_PODCAST_ID },
        { status: 502 }
      );
    }

    const feedUrl = lookupData.results[0].feedUrl;
    if (!feedUrl) {
      return Response.json(
        { error: 'Apple lookup succeeded but returned no feedUrl', raw: lookupData.results[0] },
        { status: 502 }
      );
    }

    // Step 2: fetch and parse the actual RSS feed.
    const feedRes = await fetch(feedUrl, {
      headers: { 'User-Agent': 'PuffynInsights/0.1 (+https://puffyn.app)' },
    });
    const feedXml = await feedRes.text();

    const parser = new XMLParser({ ignoreAttributes: false });
    const feedData = parser.parse(feedXml);

    const rawItems = feedData?.rss?.channel?.item;
    if (!rawItems) {
      return Response.json({ error: 'RSS feed had no episodes', feedUrl }, { status: 502 });
    }
    // fast-xml-parser returns a single object (not an array) when there's
    // only one <item>. Normalize to always be an array.
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    // Step 3: only look at the 5 most recent episodes. We don't need to
    // backfill the whole show archive for the MVP, and checking fewer
    // items keeps this fast and cheap.
    const recentItems = items.slice(0, 5);

    const supabase = getSupabaseServerClient();
    const results = [];

    for (const item of recentItems) {
      const guid = typeof item.guid === 'object' ? item.guid['#text'] : item.guid;
      const title = item.title;
      const audioUrl = item.enclosure ? item.enclosure['@_url'] : null;
      const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : null;

      if (!guid) {
        results.push({ title, status: 'skipped_no_guid' });
        continue;
      }

      // Check whether we've already recorded this episode.
      const { data: existing, error: selectError } = await supabase
        .from('episodes')
        .select('id')
        .eq('episode_guid', guid)
        .maybeSingle();

      if (selectError) {
        results.push({ title, status: 'error', detail: selectError.message });
        continue;
      }

      if (existing) {
        results.push({ title, status: 'already_known' });
        continue;
      }

      const { error: insertError } = await supabase.from('episodes').insert({
        podcast_name: PODCAST_NAME,
        episode_guid: guid,
        title,
        published_at: publishedAt,
        audio_url: audioUrl,
        transcript_status: 'pending',
      });

      if (insertError) {
        results.push({ title, status: 'error', detail: insertError.message });
      } else {
        results.push({ title, status: 'new_episode_recorded' });
      }
    }

    return Response.json({
      podcast: PODCAST_NAME,
      feedUrl,
      checked: recentItems.length,
      results,
    });
  } catch (err) {
    return Response.json({ error: 'Unexpected failure', detail: String(err) }, { status: 500 });
  }
}
