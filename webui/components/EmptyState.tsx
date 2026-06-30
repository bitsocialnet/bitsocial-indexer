export function EmptyState() {
  return (
    <section className="empty">
      <svg className="empty-orbit" viewBox="0 0 120 120" fill="none" aria-hidden>
        <defs>
          <radialGradient id="orb" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#7cb2ff" />
            <stop offset="45%" stopColor="#2563eb" />
            <stop offset="100%" stopColor="#1a4fd0" />
          </radialGradient>
        </defs>
        <ellipse cx="60" cy="60" rx="54" ry="22" stroke="#23232c" strokeWidth="1.5" />
        <ellipse cx="60" cy="60" rx="40" ry="40" stroke="#23232c" strokeWidth="1.5" />
        <circle cx="60" cy="60" r="16" fill="url(#orb)" />
        <circle cx="114" cy="60" r="3.2" fill="#2563eb" />
      </svg>

      <h1 className="empty-title">No communities indexed <em>yet</em></h1>
      <p className="empty-lead">
        This is a neutral Bitsocial indexer. It ships empty — the operator chooses which communities
        to crawl and make searchable.
      </p>

      <div className="empty-card">
        <p className="empty-card-label">To start indexing</p>
        <pre className="code">
          COMMUNITIES=art.bso,technology.bso{'\n'}
          <span className="c"># …or point at a directory of communities:</span>{'\n'}
          COMMUNITIES_SOURCE=https://example.com/communities.json
        </pre>
      </div>

      <p className="empty-foot">
        Just exploring? Run <code>npm run seed</code> in <code>server/</code> to load demo content.
      </p>
    </section>
  );
}
