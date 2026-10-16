import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 네이티브 모듈은 번들하지 않고 런타임에 node_modules에서 읽는다.
  serverExternalPackages: ['better-sqlite3', '@prisma/adapter-better-sqlite3'],
};

export default nextConfig;
