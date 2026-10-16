// HTTP 인수 테스트. 애플리케이션 코드를 import하지 않고 기동된 서버에 fetch로만 요청한다.
import { describe, expect, inject, it } from 'vitest';

describe('GET /api/health', () => {
  it('200과 { ok: true }를 돌려준다', async () => {
    const res = await fetch(new URL('/api/health', inject('baseUrl')));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });
});
