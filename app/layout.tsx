import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'forge-2',
  description: 'FORGE 2.0 governance audit, gate, resurrect, and health console.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
