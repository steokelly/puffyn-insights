import { getSupabaseServerClient } from '../../lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0; export const fetchCache = 'force-no-store';

export default async function EpisodesPage() {
  const supabase = getSupabaseServerClient();

  const { data: episodes, error } = await supabase
    .from('episodes')
    .select('id, podcast_name, title, published_at, transcript_status, main_themes, participants')
    .order('published_at', { ascending: false });

  if (error) {
    return <main style={styles.main}>Failed to load episodes: {error.message}</main>;
  }

  const { data: insights } = await supabase.from('insights').select('episode_id');
  const insightCounts = {};
  (insights || []).forEach((i) => {
    insightCounts[i.episode_id] = (insightCounts[i.episode_id] || 0) + 1;
  });

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Episodes</h1>
      <p style={styles.subheading}>{episodes.length} episodes tracked</p>

      {episodes.map((ep) => (
        <div key={ep.id} style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.podcastName}>{ep.podcast_name}</span>
            <span style={statusBadgeStyle(ep.transcript_status)}>{ep.transcript_status}</span>
          </div>
          <h2 style={styles.title}>{ep.title}</h2>
          <p style={styles.date}>
            {ep.published_at && new Date(ep.published_at).toLocaleDateString('en-IE')}
            {insightCounts[ep.id] ? ` · ${insightCounts[ep.id]} insight${insightCounts[ep.id] === 1 ? '' : 's'}` : ''}
          </p>

          {ep.main_themes && ep.main_themes.length > 0 && (
            <div style={styles.section}>
              <span style={styles.sectionLabel}>Themes:</span>
              <div style={styles.tagRow}>
                {ep.main_themes.map((theme) => (
                  <span key={theme} style={styles.themeTag}>
                    {theme}
                  </span>
                ))}
              </div>
            </div>
          )}

          {ep.participants && ep.participants.length > 0 && (
            <div style={styles.section}>
              <span style={styles.sectionLabel}>Participants:</span>
              <p style={styles.participants}>{ep.participants.join(', ')}</p>
            </div>
          )}

          {(!ep.main_themes || ep.main_themes.length === 0) && ep.transcript_status !== 'pending' && (
            <p style={styles.pending}>Themes/participants not extracted yet.</p>
          )}
        </div>
      ))}
    </main>
  );
}

function statusBadgeStyle(status) {
  const colors = {
    analyzed: '#16a34a',
    transcribed: '#2563eb',
    pending: '#94a3b8',
    error: '#dc2626',
    analysis_error: '#dc2626',
  };
  return {
    display: 'inline-block',
    padding: '0.2rem 0.6rem',
    borderRadius: '999px',
    background: colors[status] || '#94a3b8',
    color: 'white',
    fontSize: '0.75rem',
    fontWeight: 'bold',
  };
}

const styles = {
  main: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: '720px',
    margin: '0 auto',
    padding: '2rem 1.5rem',
    color: '#1e293b',
  },
  heading: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  subheading: { color: '#64748b', marginBottom: '2rem' },
  card: {
    border: '1px solid #e2e8f0',
    borderRadius: '10px',
    padding: '1.25rem',
    marginBottom: '1rem',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.5rem',
  },
  podcastName: { fontSize: '0.8rem', color: '#64748b', fontWeight: 'bold' },
  title: { fontSize: '1.15rem', margin: '0 0 0.25rem 0' },
  date: { fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.75rem' },
  section: { marginBottom: '0.5rem' },
  sectionLabel: { fontSize: '0.75rem', color: '#94a3b8', fontWeight: 'bold', marginRight: '0.4rem' },
  tagRow: { display: 'inline-flex', flexWrap: 'wrap', gap: '0.35rem' },
  themeTag: {
    background: '#f1f5f9',
    padding: '0.15rem 0.5rem',
    borderRadius: '999px',
    fontSize: '0.75rem',
  },
  participants: { fontSize: '0.9rem', margin: '0.2rem 0 0 0', color: '#334155' },
  pending: { fontSize: '0.8rem', color: '#cbd5e1', fontStyle: 'italic' },
};
