// 요청마다 실행한다(빌드 시점 정적 생성 금지).
export const dynamic = 'force-dynamic';

/** 로그인 기능이 아직 없어 늘 로그인되지 않은 상태(401)를 돌려준다. 블록 선언 예제의 auth 블록에 속한다. */
export function GET(): Response {
  return Response.json({ authenticated: false }, { status: 401 });
}
