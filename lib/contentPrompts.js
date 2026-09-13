// Shared between: /api/generate-content, /api/daily-run, /api/reformat-existing-drafts,
// and the "Regenerate" button on the review page. Keeping this in one place means a
// future style tweak only needs to happen here, not in four separate files.

export const CONTENT_SYSTEM_PROMPT = `You write short-form social posts for Puffyn, a media brand for the open-minded covering Ireland, culture, politics, and society.

Style: model your writing on accounts like @GlobeEyeNews — extremely concise, factual, almost deadpan. State the sharpest, most concrete fact or tension in one or two short sentences, then STOP. Do not explain why it matters, do not add a closing "take" or interpretation, do not use hashtags, do not use emoji. Let the fact do the work — the reader should feel compelled to react in the replies, not be told what to think.

Lead with the single most concrete, specific detail available — a number, a direct quote, a specific date or name — rather than a general statement.

You will be told an exact maximum character count. Stay comfortably under it. A source credit (episode and podcast name) will be appended separately after your text by other code, on its own line — so do NOT add your own attribution, credit, hashtag, or link.

Respond with ONLY valid JSON, no other text: { "content": "...", "format": "observation" or "question" }`;

export const REGENERATE_SYSTEM_PROMPT = `You write short-form social posts for Puffyn, in the style of accounts like @GlobeEyeNews — extremely concise, factual, almost deadpan, no hashtags, no emoji, no explaining why something matters. Let the fact speak for itself.

You'll be given an existing draft, the insight it came from, and an instruction for how to revise it. Rewrite it accordingly, keeping it in that same terse style. You will be told an exact maximum character count — a source credit is appended separately afterward on its own line, so do not add your own attribution.

Respond with ONLY valid JSON, no other text: { "content": "..." }`;

export const PLATFORM_LIMITS = { x: 280, bluesky: 300 };

// The target length for the actual written copy, before the source line is
// added underneath it.
export const COPY_TARGET = 172;

// Builds the "[Episode Title] — [Podcast Name]" line that goes underneath
// every post's copy.
export function buildSourceLine(episodeTitle, podcastName) {
  const parts = [episodeTitle, podcastName].filter(Boolean);
  return parts.join(' — ');
}

// Combines the copy and the source line into the final post text, with a
// blank line between them. If the episode/podcast names are unusually long
// and the combined result would breach the platform's hard limit, the copy
// (never the source line) is trimmed at a word boundary to make room.
export function composePost(copyText, sourceLine, platformLimit) {
  const separator = '\n\n';
  const maxCopyForPlatform = platformLimit - separator.length - sourceLine.length;
  const targetCopyLimit = Math.min(COPY_TARGET, Math.max(0, maxCopyForPlatform));

  let trimmed = (copyText || '').trim();
  if (trimmed.length > targetCopyLimit) {
    trimmed = trimmed.slice(0, targetCopyLimit);
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > 0) trimmed = trimmed.slice(0, lastSpace);
    trimmed = trimmed.trim();
  }

  return `${trimmed}${separator}${sourceLine}`;
}
