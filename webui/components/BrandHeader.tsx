import Link from 'next/link';
import { siteBadge, siteName, siteTitle } from '@/lib/site';
import { SearchBar } from './SearchBar';

export function BrandHeader() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand" aria-label={`${siteTitle} home`}>
          <span className="brand-orb" aria-hidden />
          <span className="brand-name">{siteName}</span>
          {siteBadge ? <span className="badge">{siteBadge}</span> : null}
        </Link>
        <div className="header-search">
          <SearchBar compact />
        </div>
      </div>
    </header>
  );
}
