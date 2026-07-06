import type { Metadata } from 'next';
import { Exo, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { BrandHeader } from '@/components/BrandHeader';
import { DevTools } from '@/components/DevTools';
import { SiteFooter } from '@/components/SiteFooter';
import { siteName, siteTitle, siteUrl, theme } from '@/lib/site';

const exo = Exo({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-exo', display: 'swap' });
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });

const description = 'A self-hostable search index for the Bitsocial network.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: siteTitle, template: `%s · ${siteName}` },
  description,
  openGraph: { siteName: siteTitle, type: 'website', title: siteTitle, description },
  twitter: { card: 'summary' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme={theme} className={`${exo.variable} ${manrope.variable}`}>
      <body>
        <DevTools />
        <div className="glow" aria-hidden />
        <BrandHeader />
        <main className="container">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
