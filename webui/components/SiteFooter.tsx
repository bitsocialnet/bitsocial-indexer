import Link from 'next/link';
import { brandText, brandUrl } from '@/lib/site';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <span>A neutral indexer for the Bitsocial network.</span>
        {brandText ? (
          <span className="brand-line">
            {brandUrl ? (
              <a href={brandUrl} rel="noopener noreferrer">{brandText}</a>
            ) : (
              brandText
            )}
          </span>
        ) : null}
        <span>
          <Link href="/legal">Legal</Link> · Open source ·{' '}
          <a href="https://github.com/bitsocialnet/bitsocial-indexer">GPL-3.0-or-later</a>
        </span>
      </div>
    </footer>
  );
}
