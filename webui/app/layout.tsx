import type { Metadata } from 'next';
import { Exo, Manrope } from 'next/font/google';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import './globals.css';
import { BrandHeader } from '@/components/BrandHeader';
import { DevTools } from '@/components/DevTools';
import { PerfBoundary } from '@/components/PerfBoundary';
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Branding and theme come from the runtime env (lib/site.ts). Without this
  // the built-in 404 page is the one route prerendered at build time, and an
  // instance rebranded or themed through env still shows the build's defaults.
  await connection();
  return (
    <html lang="en" data-theme={theme} className={`${exo.variable} ${manrope.variable}`}>
      <body>
        <DevTools />
        <div className="glow" aria-hidden />
        <PerfBoundary>
          <BrandHeader />
          <main className="container">{children}</main>
          <SiteFooter />
        </PerfBoundary>
      </body>
    </html>
  );
}
