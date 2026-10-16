// SCR-00 앱 셸 (ADR-043). 지금은 빈 셸: 문서 제목과 연결 상태 문구 자리만 있다.
// 레이아웃 · 사이드바 연결 상태(system.status)가 들어오면 #13(M0-10)이 이 목록을 고친다.
import type { ScreenChecklist } from './types.js';

const connection = (state: string, text: string) =>
  ({
    label: '연결 상태 문구',
    testId: 'connection-status',
    role: 'status',
    text,
    attributes: { 'data-state': state },
  }) as const;

export const shellChecklist = {
  id: 'SCR-00',
  name: '앱 셸',
  states: {
    기본: { title: 'BIVE', elements: [connection('connected', '오케스트레이터 연결됨')] },
    로딩: { title: 'BIVE', elements: [connection('checking', '오케스트레이터 연결 확인 중')] },
    에러: { title: 'BIVE', elements: [connection('disconnected', '오케스트레이터 연결 끊김')] },
  },
} satisfies ScreenChecklist;
