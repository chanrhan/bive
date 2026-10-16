import { defineConfig } from 'prisma/config';

// DATABASE_URL이 없으면(설치 직후 prisma generate 등) 프로젝트 안 dev.db를 쓴다.
// 테스트 · 판정 서버는 항상 임시 경로의 DATABASE_URL을 넘긴다.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./dev.db',
  },
});
