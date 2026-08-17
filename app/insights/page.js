import { getSupabaseServerClient } from '../../lib/supabase';

// This is a Server Component: it runs on Vercel's servers, not in the
// visitor's browser, so it's safe to use the service role key here even
// though this page will be publicly visible.
export default async function InsightsPage() {
  const supabase = getSupabaseServerClient();

  const { data: insights, error } = await supabase
    .from('insights')
    .select('*, episodes(title, published_at)')
    .gte('puffyn_score', 50) // per the brief's thresholds: below 50 is ignored entirely
    .order('puffyn_score', { ascending: false });

  if (error) {
    return <main style={styles.main}>Failed to load insights: {error.message}</main>;
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Puffyn Insight Bank</h1>
      <p style={styles.subheading}>{insights.length} insights, sorted by Puffyn Score</p>

      {insights.map((insight) => (
        <div key={insight.id} style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={scoreBadgeStyle(insight.puffyn_score)}>{insight.puffyn_score}</span>
            <h2 style={styles.title}>{insight.title}</h2>
          </div>
          <p style={styles.explanation}>{insight.explanation}</p>
          <div style={styles.meta}>
            <span>{insight.topic}</span>
            {insight.tags && insight.tags.length > 0 && (
              <span style={styles.tags}>
                {insight.tags.map((tag) => (
                  <span key={tag} style={styles.tag}>
                    {tag}
                  </span>
                ))}
              </span>
            )}
          </div>
          <p style={styles.source}>
            From: {insight.episodes?.title}
            {insight.episodes?.published_at &&
              ` · ${new Date(insight.episodes.published_at).toLocaleDateString('en-IE')}`}
          </p>
        </div>
      ))}
    </main>
  );
}

function scoreBadgeStyle(score) {
  let background = '#94a3b8'; // 50-69: grey, "archive unless useful alongside another source"
  if (score >= 85) background = '#16a34a'; // develop into content
  else if (score >= 70) background = '#2563eb'; // save to insight bank

  return {
    display: 'inline-block',
    minWidth: '2.5rem',
    textAlign: 'center',
    padding: '0.25rem 0.5rem',
    borderRadius: '6px',
    background,
    color: 'white',
    fontWeight: 'bold',
    fontSize: '0.9rem',
  };
}

const styles = {
  main: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: '760px',
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
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '0.5rem',
  },
  title: { fontSize: '1.1rem', margin: 0 },
  explanation: { color: '#334155', lineHeight: 1.5, marginBottom: '0.75rem' },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.85rem',
    color: '#64748b',
    marginBottom: '0.5rem',
  },
  tags: { display: 'flex', gap: '0.4rem' },
  tag: {
    background: '#f1f5f9',
    padding: '0.15rem 0.5rem',
    borderRadius: '999px',
    fontSize: '0.75rem',
  },
  source: { fontSize: '0.8rem', color: '#94a3b8', margin: 0 },
};
