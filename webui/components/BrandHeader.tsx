import Link from 'next/link';
import { SearchBar } from './SearchBar';

export function BrandHeader() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand" aria-label="Bitsocial Indexer home">
          <span className="brand-orb" aria-hidden />
          <span className="brand-name">Bitsocial</span>
          <span className="badge">Indexer</span>
        </Link>
        <div className="header-search">
          <SearchBar compact />
        </div>
      </div>
    </header>
  );
}
