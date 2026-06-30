export function SearchBar({ compact = false, defaultValue = '' }: { compact?: boolean; defaultValue?: string }) {
  return (
    <form action="/search" method="get" className={`searchbar${compact ? ' searchbar-compact' : ''}`} role="search">
      <input
        className="input"
        type="search"
        name="q"
        placeholder="Search indexed posts…"
        defaultValue={defaultValue}
        aria-label="Search indexed posts"
      />
      <button className="btn" type="submit">Search</button>
    </form>
  );
}
