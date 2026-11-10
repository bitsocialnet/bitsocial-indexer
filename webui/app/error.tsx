'use client';

/**
 * Pages throw when the indexer API fails instead of rendering a "not found"
 * page, so an outage answers 5xx and is never mistaken for missing content.
 * This keeps the error page inside the site layout.
 */
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="notice">
      <strong>This page couldn’t be loaded.</strong> The indexer API may be unreachable right now.{' '}
      <button className="btn" type="button" onClick={() => retry()}>
        Try again
      </button>
    </div>
  );
}
