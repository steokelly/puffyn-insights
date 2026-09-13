'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '../../lib/supabase';
import { REGENERATE_SYSTEM_PROMPT, PLATFORM_LIMITS, COPY_TARGET, buildSourceLine, composePost } from '../../lib/contentPrompts';

export async function approveDraft(formData) {
  const id = formData.get('id');
  const supabase = getSupabaseServerClient();
  await supabase.from('content_drafts').update({ status: 'approved' }).eq('id', id);
  revalidatePath('/review');
}

export async function rejectDraft(formData) {
  const id = formData.get('id');
  const supabase = getSupabaseServerClient();
  await supabase.from('content_drafts').update({ status: 'rejected' }).eq('id', id);
  revalidatePath('/review');
}

export async function editDraft(formData) {
  const id = formData.get('id');
  const newContent = formData.get('content');
  const supabase = getSupabaseServerClient();
  await supabase.from('content_drafts').update({ content: newContent }).eq('id', id);
  revalidatePath('/review');
}

const REGENERATE_INSTRUCTIONS = {
  shorter: 'Make it noticeably shorter and punchier, same core idea.',
  more_thoughtful: 'Make it more thoughtful and nuanced, less punchy, more considered.',
  more_provocative: 'Make it more provocative and attention-grabbing, while staying factually honest and not misleading.',
  more_neutral: 'Make it more neutral in tone, less opinionated, more measured.',
  different_angle: 'Take a genuinely different angle on the same underlying insight, not just reworded.',
};

export async function regenerateDraft(formData) {
  const id = formData.get('id');
  const style = formData.get('style');
  const supabase = getSupabaseServerClient();

  const { data: draft } = await supabase
    .from('content_drafts')
    .select('*, insights(title, explanation, episodes(title, podcast_name))')
    .eq('id', id)
    .maybeSingle();

  if (!draft) {
    console.error('regenerateDraft: no draft found for id', id);
    return;
  }

  const sourceLine = buildSourceLine(draft.insights?.episodes?.title, draft.insights?.episodes?.podcast_name);
  const instruction = REGENERATE_INSTRUCTIONS[style] || REGENERATE_INSTRUCTIONS.different_angle;
  const existingCopy = draft.content.replace(`\n\n${sourceLine}`, '');

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
      system: REGENERATE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Platform: ${draft.platform}\n\nInsight: ${draft.insights?.title}\n${draft.insights?.explanation}\n\nCurrent draft (source credit already stripped): ${existingCopy}\n\nInstruction: ${instruction}\n\nMaximum character count for your text (before the source credit is re-added): ${COPY_TARGET}`,
        },
      ],
    }),
  });

  if (!claudeRes.ok) {
    const errorBody = await claudeRes.text();
    console.error('regenerateDraft: Claude request failed', claudeRes.status, errorBody);
    return;
  }

  const claudeData = await claudeRes.json();
  const textBlock = claudeData?.content?.find((block) => block.type === 'text');
  const rawText = textBlock?.text || '';

  try {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.content) {
      await supabase
        .from('content_drafts')
        .update({ content: composePost(parsed.content, sourceLine, PLATFORM_LIMITS[draft.platform]) })
        .eq('id', id);
    } else {
      console.error('regenerateDraft: parsed JSON had no content field', rawText);
    }
  } catch (err) {
    console.error('regenerateDraft: failed to parse Claude output as JSON', rawText, String(err));
  }

  revalidatePath('/review');
}
