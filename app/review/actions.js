'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '../../lib/supabase';

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

const REGENERATE_SYSTEM_PROMPT = `You write short-form social content for Puffyn, a media brand for the open-minded covering Ireland, culture, politics, and society. Puffyn's voice: curious, intelligent, progressive, open-minded, thoughtful, accessible, willing to challenge conventional thinking, distinctly human. Never generic-AI-sounding, never rage-baiting, never overstating evidence, never emoji-heavy.

You'll be given an existing draft post, the insight it came from, and an instruction for how to revise it. Rewrite it accordingly. Keep it appropriate for the same platform (X posts must stay under 280 characters; Bluesky can be a little longer).

Respond with ONLY valid JSON, no other text: { "content": "..." }`;

export async function regenerateDraft(formData) {
  const id = formData.get('id');
  const style = formData.get('style');
  const supabase = getSupabaseServerClient();

  const { data: draft } = await supabase
    .from('content_drafts')
    .select('*, insights(title, explanation)')
    .eq('id', id)
    .maybeSingle();

  if (!draft) {
    console.error('regenerateDraft: no draft found for id', id);
    return;
  }

  const instruction = REGENERATE_INSTRUCTIONS[style] || REGENERATE_INSTRUCTIONS.different_angle;

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
          content: `Platform: ${draft.platform}\n\nInsight: ${draft.insights?.title}\n${draft.insights?.explanation}\n\nCurrent draft: ${draft.content}\n\nInstruction: ${instruction}`,
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
      await supabase.from('content_drafts').update({ content: parsed.content }).eq('id', id);
    } else {
      console.error('regenerateDraft: parsed JSON had no content field', rawText);
    }
  } catch (err) {
    console.error('regenerateDraft: failed to parse Claude output as JSON', rawText, String(err));
  }

  revalidatePath('/review');
}
