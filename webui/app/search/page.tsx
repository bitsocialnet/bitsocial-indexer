import type { Metadata } from 'next';
import { ApiDown } from '@/components/Notice';
import { PostCard } from '@/components/PostCard';
import { SearchBar } from '@/components/SearchBar';
import { search } from '@/lib/api';

export const metadata: Metadata = { title: 'Search' };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const query = (q ?? '').trim();
  const result = query ? await search(query) : null;
  const apiDown = query !== '' && result === null;

  return (
    <div>
      <div className="page-search">
        <SearchBar defaultValue={query} />
      </div>

      {apiDown ? <ApiDown /> : null}

      {query && result ? (
        <>
          <div className="results-head">
            <h1>Results for “{result.query}”</h1>
            <p>{result.total} {result.total === 1 ? 'match' : 'matches'}</p>
          </div>
          {result.posts.length === 0 ? (
            <div className="notice">No posts matched. Try broader terms.</div>
          ) : (
            result.posts.map((p) => <PostCard key={p.cid} post={p} />)
          )}
        </>
      ) : !apiDown ? (
        <p className="muted" style={{ textAlign: 'center' }}>Search the indexed communities.</p>
      ) : null}
    </div>
  );
}
