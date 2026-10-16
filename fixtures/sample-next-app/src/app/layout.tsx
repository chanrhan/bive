import type { ReactNode } from 'react';

export const metadata = {
  title: 'Sample Next App',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
