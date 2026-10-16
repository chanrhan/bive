import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

import { PrismaClient } from '@/generated/prisma/client';

let client: PrismaClient | undefined;

/** 첫 요청에서 Prisma 클라이언트를 만든다. 빌드 중에는 데이터베이스에 연결하지 않는다. */
export function getDb(): PrismaClient {
  if (!client) {
    const url = process.env.DATABASE_URL ?? 'file:./dev.db';
    client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  }
  return client;
}
