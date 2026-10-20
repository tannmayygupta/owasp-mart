import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { SessionProvider } from '../lib/session';
import { Nav } from './nav';
import './globals.css';

export const metadata = { title: 'VulnMart' };

// Reading the request headers makes every page render per request, which the CSP nonce needs (proxy.ts sets it;
// Next.js puts it on its own scripts). Styles come from a stylesheet: the CSP allows no inline style in production.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en">
      <body data-nonce-set={nonce ? 'true' : 'false'}>
        <SessionProvider>
          <Nav />
          <main>{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
