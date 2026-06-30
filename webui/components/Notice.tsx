import { apiBase } from '@/lib/api';

/** Shown when the indexer API can't be reached. */
export function ApiDown() {
  return (
    <div className="notice">
      <strong>The indexer API isn’t reachable.</strong> Start it with{' '}
      <code>cd server &amp;&amp; npm run dev</code> — expected at <code>{apiBase}</code>.
    </div>
  );
}
