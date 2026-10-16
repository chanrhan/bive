import { getDb } from '@/lib/db';

// 요청마다 실행한다(빌드 시점 정적 생성 금지).
export const dynamic = 'force-dynamic';

/** 데이터베이스를 한 번 읽어 연결을 확인한 뒤 상태를 돌려준다. */
export async function GET(): Promise<Response> {
  await getDb().item.count();
  return Response.json({ ok: true });
}
