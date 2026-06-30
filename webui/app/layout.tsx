import type { Metadata } from 'next';
import { Exo, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { BrandHeader } from '@/components/BrandHeader';
import { SiteFooter } from '@/components/SiteFooter';

const exo = Exo({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-exo', display: 'swap' });
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Bitsocial Indexer', template: '%s · Bitsocial Indexer' },
  description: 'A neutral, self-hostable search index for the Bitsocial network.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${exo.variable} ${manrope.variable}`}>
      <body>
        <div className="glow" aria-hidden />
        <BrandHeader />
        <main className="container">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
