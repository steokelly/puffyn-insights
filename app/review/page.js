import { getSupabaseServerClient } from '../../lib/supabase';
import { approveDraft, rejectDraft, editDraft, regenerateDraft } from './actions';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const supabase = getSupabaseServerClient();

  const { data: drafts, error } = await supabase
    .from('content_drafts')
    .select('*, insights(title, puffyn_score)')
    .eq('status', 'pending_review')
    .order('created_at', { ascending: true });

  if (error) {
    return <main style={styles.main}>Failed to load drafts: {error.message}</main>;
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Review Queue</h1>
      <p style={styles.subheading}>
        {drafts.length} draft{drafts.length === 1 ? '' : 's'} waiting for your decision
      </p>

      {drafts.length === 0 && <p style={styles.empty}>Nothing waiting right now.</p>}

      {drafts.map((draft) => (
        <div key={draft.id} style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={platformBadgeStyle(draft.platform)}>{draft.platform}</span>
            {draft.format && <span style={styles.formatLabel}>{draft.format}</span>}
          </div>
          <p style={styles.content}>{draft.content}</p>
          <p style={styles.source}>
            From insight: {draft.insights?.title} (score {draft.insights?.puffyn_score})
          </p>

          <form action={editDraft} style={styles.editForm}>
            <input type="hidden" name="id" value={draft.id} />
            <textarea name="content" defaultValue={draft.content} style={styles.textarea} rows={3} />
            <button type="submit" style={styles.saveButton}>
              Save edit
            </button>
          </form>

          <form action={regenerateDraft} style={styles.regenerateForm}>
            <input type="hidden" name="id" value={draft.id} />
            <select name="style" style={styles.select} defaultValue="different_angle">
              <option value="shorter">Shorter</option>
              <option value="more_thoughtful">More thoughtful</option>
              <option value="more_provocative">More provocative</option>
              <option value="more_neutral">More neutral</option>
              <option value="different_angle">Different angle</option>
            </select>
            <button type="submit" style={styles.regenerateButton}>
              Regenerate
            </button>
          </form>

          <div style={styles.actions}>
            <form action={approveDraft}>
              <input type="hidden" name="id" value={draft.id} />
              <button type="submit" style={styles.approveButton}>
                Approve
              </button>
            </form>
            <form action={rejectDraft}>
              <input type="hidden" name="id" value={draft.id} />
              <button type="submit" style={styles.rejectButton}>
                Reject
              </button>
            </form>
          </div>
        </div>
      ))}
    </main>
  );
}

function platformBadgeStyle(platform) {
  return {
    display: 'inline-block',
    padding: '0.2rem 0.6rem',
    borderRadius: '999px',
    background: platform === 'x' ? '#0f172a' : '#0284c7',
    color: 'white',
    fontSize: '0.75rem',
    fontWeight: 'bold',
    textTransform: 'uppercase',
  };
}

const styles = {
  main: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: '640px',
    margin: '0 auto',
    padding: '2rem 1.5rem',
    color: '#1e293b',
  },
  heading: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  subheading: { color: '#64748b', marginBottom: '2rem' },
  empty: { color: '#94a3b8' },
  card: {
    border: '1px solid #e2e8f0',
    borderRadius: '10px',
    padding: '1.25rem',
    marginBottom: '1rem',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.75rem',
  },
  formatLabel: { fontSize: '0.8rem', color: '#64748b' },
  content: { fontSize: '1.05rem', lineHeight: 1.5, marginBottom: '0.75rem' },
  source: { fontSize: '0.8rem', color: '#94a3b8', marginBottom: '1rem' },
  editForm: { marginBottom: '0.75rem' },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '0.5rem',
    borderRadius: '6px',
    border: '1px solid #cbd5e1',
    fontFamily: 'inherit',
    fontSize: '0.9rem',
    marginBottom: '0.4rem',
  },
  saveButton: {
    background: '#e2e8f0',
    color: '#1e293b',
    border: 'none',
    padding: '0.4rem 0.8rem',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  regenerateForm: {
    display: 'flex',
    gap: '0.5rem',
    marginBottom: '0.75rem',
  },
  select: {
    padding: '0.4rem',
    borderRadius: '6px',
    border: '1px solid #cbd5e1',
    fontSize: '0.85rem',
  },
  regenerateButton: {
    background: '#7c3aed',
    color: 'white',
    border: 'none',
    padding: '0.4rem 0.8rem',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  actions: { display: 'flex', gap: '0.5rem' },
  approveButton: {
    background: '#16a34a',
    color: 'white',
    border: 'none',
    padding: '0.5rem 1rem',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
  rejectButton: {
    background: '#f1f5f9',
    color: '#334155',
    border: 'none',
    padding: '0.5rem 1rem',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
  },
};
