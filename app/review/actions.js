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
