// e2e 전용 플레이그라운드: 화면이 아직 없는 공용 목록 · 카드 · 상태 배지 · 상세 접힘을 그린다 (ADR-048, e2e/list.spec.ts).
// 테스트 데이터는 이 파일 안에만 둔다 (제품 코드 경로 금지, NFR-03). `/playground/list.html`로 연다.
//
// 구성: 위쪽 버튼으로 "화면"을 바꾼다(컴포넌트가 사라졌다 다시 생긴다). 첫 목록 · 둘째 목록은 목록 ID가 달라
// 필터 상태를 따로 가진다. 배지 화면에는 상태 8종과 상세 접힘이 있다.
import '../../src/renderer/styles/tokens.css';
import '../../src/renderer/styles/app.css';

import type { AuthorKind, JudgmentStatus, MutationStatus } from '@bive/shared';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { CollapsibleDetail } from '../../src/renderer/src/components/CollapsibleDetail/index.js';
import {
  type FilterCriterion,
  ListView,
} from '../../src/renderer/src/components/ListView/index.js';
import {
  type BadgeStatus,
  JUDGMENT_LABELS,
  MUTATION_LABELS,
  StatusBadge,
} from '../../src/renderer/src/components/StatusBadge/index.js';

interface Row {
  key: string;
  id: string;
  title: string;
  judgment: JudgmentStatus;
  mutation?: MutationStatus;
  author: AuthorKind;
  at: string;
}

const FIRST: Row[] = [
  {
    key: 'r1',
    id: 'RULE-001',
    title: '로그인 실패 5회 시 계정 잠금',
    judgment: 'pass',
    author: 'human',
    at: '2026-10-01T09:00:00',
  },
  {
    key: 'r2',
    id: 'RULE-002',
    title:
      '주문 취소는 결제 승인 후 24시간 이내에만 허용하고 부분 환불은 관리자 승인 뒤에만 처리한다',
    judgment: 'fail',
    author: 'agent',
    at: '2026-10-02T09:00:00',
  },
  {
    key: 'r3',
    id: 'RULE-003',
    title: '주문 생성 시 재고 차감',
    judgment: 'pass',
    mutation: 'unverified',
    author: 'agent',
    at: '2026-10-05T09:00:00',
  },
  {
    key: 'r4',
    id: 'RULE-004',
    title: '결제 승인 응답 3초 이내',
    judgment: 'quarantined',
    author: 'human',
    at: '2026-10-03T09:00:00',
  },
  {
    key: 'r5',
    id: 'RULE-005',
    title: '헬스 체크 응답 형식',
    judgment: 'needs_recheck',
    mutation: 'survived',
    author: 'agent',
    at: '2026-10-04T09:00:00',
  },
  {
    key: 'r6',
    id: 'RULE-006',
    title: '세션 만료 30분',
    judgment: 'pass',
    mutation: 'verified',
    author: 'human',
    at: '2026-09-30T09:00:00',
  },
];

const SECOND: Row[] = [
  {
    key: 's1',
    id: 'REQ-001',
    title: '회원 가입',
    judgment: 'pass',
    author: 'human',
    at: '2026-10-01T10:00:00',
  },
  {
    key: 's2',
    id: 'REQ-002',
    title: '비밀번호 재설정',
    judgment: 'fail',
    author: 'human',
    at: '2026-10-02T10:00:00',
  },
  {
    key: 's3',
    id: 'REQ-003',
    title: '주문 내역 조회',
    judgment: 'pass',
    author: 'agent',
    at: '2026-10-03T10:00:00',
  },
];

const JUDGMENTS: JudgmentStatus[] = ['pass', 'fail', 'unjudged', 'quarantined', 'needs_recheck'];
const MUTATIONS: MutationStatus[] = ['verified', 'unverified', 'survived'];

const CRITERIA: FilterCriterion<Row>[] = [
  {
    id: 'judgment',
    label: '상태',
    options: JUDGMENTS.map((value) => ({ value, label: JUDGMENT_LABELS[value] })),
    values: (row) => [row.judgment],
  },
  {
    id: 'author',
    label: '생성 주체',
    options: [
      { value: 'human', label: '사람' },
      { value: 'agent', label: '에이전트' },
    ],
    values: (row) => [row.author],
  },
  {
    id: 'mutation',
    label: '변이',
    options: MUTATIONS.map((value) => ({ value, label: MUTATION_LABELS[value] })),
    values: (row) => (row.mutation === undefined ? [] : [row.mutation]),
  },
];

const toCard = (row: Row) => ({
  title: row.title,
  id: row.id,
  statuses: [
    { kind: 'judgment', status: row.judgment } as const,
    ...(row.mutation === undefined ? [] : [{ kind: 'mutation', status: row.mutation } as const]),
  ],
  author: row.author,
  dateTime: row.at,
});

const rowKey = (row: Row): string => row.key;

type View = 'first' | 'second' | 'empty' | 'badges' | 'other';

const VIEWS: { id: View; label: string }[] = [
  { id: 'first', label: '첫 목록' },
  { id: 'second', label: '둘째 목록' },
  { id: 'empty', label: '빈 목록' },
  { id: 'badges', label: '배지' },
  { id: 'other', label: '다른 화면' },
];

const ALL_BADGES: BadgeStatus[] = [
  ...JUDGMENTS.map((status) => ({ kind: 'judgment', status }) as const),
  ...MUTATIONS.map((status) => ({ kind: 'mutation', status }) as const),
];

const Badges = (): React.JSX.Element => {
  const [failed, setFailed] = useState(false);
  return (
    <div style={{ padding: 'var(--space-4)' }}>
      <ul data-testid="badge-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {ALL_BADGES.map((badge) => (
          <li key={`${badge.kind}:${badge.status}`} style={{ padding: 'var(--space-1) 0' }}>
            <StatusBadge {...badge} />
          </li>
        ))}
      </ul>
      <button type="button" data-testid="judge-fail" onClick={() => setFailed(true)}>
        판정 실패
      </button>
      <CollapsibleDetail title="변경 이력">
        <p>이력 본문</p>
      </CollapsibleDetail>
      <CollapsibleDetail title="테스트 출력" forceOpen={failed}>
        <pre>출력 본문</pre>
      </CollapsibleDetail>
    </div>
  );
};

const Playground = (): React.JSX.Element => {
  const [view, setView] = useState<View>('first');
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <nav
        aria-label="플레이그라운드"
        style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-2)' }}
      >
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={view === item.id}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div
        data-testid="playground-pane"
        style={{ display: 'flex', flex: 1, minHeight: 0, width: 'var(--list-pane-width)' }}
      >
        {view === 'first' && (
          <ListView
            listId="playground-first"
            label="첫 목록"
            items={FIRST}
            itemKey={rowKey}
            card={toCard}
            criteria={CRITERIA}
            emptyText="규칙 없음"
            selectedKey={selected}
            onSelect={(row) => setSelected(row.key)}
          />
        )}
        {view === 'second' && (
          <ListView
            listId="playground-second"
            label="둘째 목록"
            items={SECOND}
            itemKey={rowKey}
            card={toCard}
            criteria={CRITERIA}
            emptyText="요구사항 없음"
          />
        )}
        {view === 'empty' && (
          <ListView
            listId="playground-empty"
            label="빈 목록"
            items={[]}
            itemKey={rowKey}
            card={toCard}
            criteria={CRITERIA}
            emptyText="규칙 없음"
          />
        )}
        {view === 'badges' && <Badges />}
        {view === 'other' && <p data-testid="other-view">다른 화면 본문</p>}
      </div>
    </div>
  );
};

const container = document.getElementById('root');
if (container === null) throw new Error('#root 요소 없음');
createRoot(container).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
