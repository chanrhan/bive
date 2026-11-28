// 확인할 것 (SCR-17 자리, M7-14 #226, ADR-119)의 카드 · 필터 · 상세 · 판단 카드 · 배지 값과 표시명 대조.
// 화면에 실제로 보이는지 · 순서 · [확인] 호출 · 배치는 e2e/scr-17.spec.ts · todo-entry.spec.ts · todo-badge.spec.ts.
// e2e 가짜 응답(e2e/checklists/scr-17.ts)이 shared 스키마와 맞는지도 여기서 파싱해 본다.
import {
  AGENT_ROLE_LABELS as SHARED_AGENT_ROLE_LABELS,
  CHECK_KIND_LABELS as SHARED_CHECK_KIND_LABELS,
  CONFIRMATION_ITEM_KIND_LABELS,
  type ConfirmationItem,
  ConfirmationItemKind,
  ConfirmationListResult,
  ConfirmationSetResult,
  NormChangeListResult,
  type NormChangeView,
  NormJudgmentSubject,
  NormJudgmentVerdict,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_CHANGE_LIST,
  FIXTURE_CHANGES,
  FIXTURE_CONFIRM_RULE4,
  FIXTURE_ITEMS,
  FIXTURE_LIST,
  FIXTURE_CHANGE_LIST_BROKEN,
  FIXTURE_CHANGE_LIST_MORE,
  FIXTURE_LIST_AFTER_RULE4,
  FIXTURE_TRUNCATED,
  FIXTURE_TRUNCATED_ONE,
  ID,
  ITEM_REQ2,
  ITEM_RETIRED,
  ITEM_RETIRED_TRUNCATED,
  ITEM_RULE3,
  ITEM_RULE5,
  ITEM_SUPERSEDED,
  ITEM_TEST_1,
  ITEM_TEST_2,
  RLO_RATIONALE_SHOWN,
  RULE5_STATEMENT,
  SUPERSEDE_GROUNDS,
} from '../e2e/checklists/scr-17.js';
import {
  countOptions,
  EMPTY_FILTER,
  type ListEntry,
} from '../src/renderer/src/components/ListView/filter.js';
import { AGENT_ROLE_LABELS, CHECK_KIND_LABELS } from '../src/renderer/src/proposals/labels.js';
import {
  CONFIRMATION_CRITERIA,
  CONFIRMATION_ITEM_KIND_TEXT,
  confirmationCard,
  confirmationDetail,
  confirmationKey,
  confirmErrorText,
  confirmStateOf,
  confirmTarget,
  isStaleConfirm,
  judgmentCard,
  judgmentCards,
  judgmentTargets,
  KIND_TAGS,
  kindTag,
  sameTargetCount,
  todoBadgeTotal,
  todoBreakdown,
} from '../src/renderer/src/screens/todo/confirmationView.js';

const items: readonly ConfirmationItem[] = FIXTURE_ITEMS;

describe('표시명 (shared 대조)', () => {
  it('항목 종류 · 역할 · 검사 종류 표시명이 shared 표와 같고, 종류 태그는 항목 종류를 빠짐없이 갖는다', () => {
    expect(CONFIRMATION_ITEM_KIND_TEXT).toEqual(CONFIRMATION_ITEM_KIND_LABELS);
    expect(Object.keys(CONFIRMATION_ITEM_KIND_TEXT)).toEqual(ConfirmationItemKind.options);
    expect(Object.keys(KIND_TAGS)).toEqual(ConfirmationItemKind.options);
    expect(AGENT_ROLE_LABELS).toEqual(SHARED_AGENT_ROLE_LABELS);
    expect(CHECK_KIND_LABELS).toEqual(SHARED_CHECK_KIND_LABELS);
  });
});

describe('e2e 가짜 응답이 shared 스키마와 맞는다', () => {
  it('목록 · 확인 뒤 목록 · 규범 변경 기록 · [확인] 응답을 파싱하면 그대로다', () => {
    expect(ConfirmationListResult.parse(FIXTURE_LIST)).toEqual(FIXTURE_LIST);
    expect(ConfirmationListResult.parse(FIXTURE_LIST_AFTER_RULE4)).toEqual(
      FIXTURE_LIST_AFTER_RULE4,
    );
    expect(NormChangeListResult.parse(FIXTURE_CHANGE_LIST)).toEqual(FIXTURE_CHANGE_LIST);
    expect(ConfirmationSetResult.parse(FIXTURE_CONFIRM_RULE4)).toEqual(FIXTURE_CONFIRM_RULE4);
    // spec들이 쓰는 나머지 가짜 응답 (잘린 목록 · 잘린 글 · 깨진 체인 · 판단이 더해진 기록)
    for (const list of [FIXTURE_TRUNCATED, FIXTURE_TRUNCATED_ONE]) {
      expect(ConfirmationListResult.parse(list)).toEqual(list);
    }
    expect(
      ConfirmationListResult.parse({ ...FIXTURE_LIST, items: [ITEM_RETIRED_TRUNCATED] }),
    ).toBeTruthy();
    for (const changes of [FIXTURE_CHANGE_LIST_BROKEN, FIXTURE_CHANGE_LIST_MORE]) {
      expect(NormChangeListResult.parse(changes)).toEqual(changes);
    }
    // 종류별 수의 합이 total과 다른 응답은 스키마가 거부한다 (옛 spec의 잘린 목록 같은 것)
    expect(
      ConfirmationListResult.safeParse({ ...FIXTURE_LIST, total: 250, truncated: true }).success,
    ).toBe(false);
    expect(FIXTURE_LIST.total).toBe(7);
    expect(FIXTURE_LIST_AFTER_RULE4.total).toBe(5);
  });
});

describe('카드: 종류 태그 · 예외 · 확인 상태 (ADR-119 표)', () => {
  it('항목마다 태그 · 예외 · 확인 상태 · 표시 ID · 제목이 정해진 대로다', () => {
    const rows = items.map((item) => {
      const card = confirmationCard(item);
      return [card.tag, card.id, card.exceptions?.map((e) => e.label).join(), confirmStateOf(item)];
    });
    expect(rows).toEqual([
      ['대체', 'RULE-001', '확인 풀림', 'released'],
      ['폐기', 'RULE-002', '미확인', 'unconfirmed'],
      ['변경', 'RULE-004', '테스트 변경', 'confirmed'],
      ['변경', 'RULE-004', '테스트 변경', 'confirmed'],
      ['신규', 'RULE-003', '미확인', 'unconfirmed'],
      ['신규', 'RULE-005', '미확인', 'unconfirmed'],
      ['요구사항', 'REQ-002', '미확인', 'unconfirmed'],
    ]);
    expect(confirmationCard(ITEM_SUPERSEDED)).toMatchObject({
      title: ITEM_SUPERSEDED.before.title,
      dateTime: ITEM_SUPERSEDED.at,
    });
    expect(confirmationCard(ITEM_TEST_1).title).toBe(ITEM_TEST_1.title);
    expect(confirmationCard(ITEM_REQ2).title).toBe(ITEM_REQ2.text);
    // 폐기 직전 내용을 읽지 못한 기록은 "알 수 없음" (날 값 · 빈 제목을 그리지 않음)
    expect(confirmationCard({ ...ITEM_RETIRED, before: null }).title).toBe('알 수 없음');
  });

  it('제목의 숨은 글자는 표기로, 이미 표시 값인 역슬래시 표기는 그대로다', () => {
    expect(confirmationCard({ ...ITEM_RULE3, text: 'A\u202eB' }).title).toBe('A\\u202eB');
    expect(confirmationCard({ ...ITEM_RULE3, text: 'A\\u202eB' }).title).toBe('A\\u202eB');
    expect(kindTag({ ...ITEM_REQ2 })).toBe('요구사항');
  });

  it('키 · [확인] 대상: 기록 항목은 순번 키에 그 규칙 대상, 미확인 규범은 대상 키 · 대상', () => {
    expect(items.map(confirmationKey)).toEqual([
      'superseded:10',
      'retired:7',
      'test_changed:6',
      'test_changed:5',
      `Rule:${ID.rule3}`,
      `Rule:${ID.rule5}`,
      `Requirement:${ID.req2}`,
    ]);
    expect(confirmTarget(ITEM_TEST_2)).toEqual({ entity: 'Rule', id: ID.rule4 });
    expect(confirmTarget(ITEM_REQ2)).toEqual({ entity: 'Requirement', id: ID.req2 });
    // 같은 대상 항목 수: 테스트 변경 2건은 서로를 센다, 나머지는 0
    expect(items.map((item) => sameTargetCount(items, item))).toEqual([0, 0, 1, 1, 0, 0, 0]);
  });
});

describe('필터 칩 4종 (수용 기준 4)', () => {
  const entries: ListEntry<ConfirmationItem>[] = items.map((item, index) => ({
    item,
    key: confirmationKey(item),
    searchText: '',
    problem: true,
    time: null,
    index,
  }));

  it('확인 상태 · 종류 · 위험도 · 생성 주체, 값별 개수는 항목에서만 센다 (위험도는 항목의 `risk`, ADR-126)', () => {
    expect(CONFIRMATION_CRITERIA.map((c) => [c.id, c.label])).toEqual([
      ['confirm', '확인 상태'],
      ['kind', '종류'],
      ['risk', '위험도'],
      ['author', '생성 주체'],
    ]);
    expect(countOptions(entries, CONFIRMATION_CRITERIA, EMPTY_FILTER)).toEqual({
      confirm: { unconfirmed: 4, released: 1, confirmed: 2 },
      kind: { retired: 1, superseded: 1, test_changed: 2, rule: 2, requirement: 1 },
      // 대체 · 미확인 RULE-003 높음, 폐기 보통, 테스트 변경 2건 낮음. 칸이 없는 RULE-005 · 요구사항은 세지 않는다
      risk: { low: 2, medium: 1, high: 2 },
      author: {
        'rule-writer': 4,
        planner: 0,
        'test-writer': 0,
        implementer: 0,
        // 변이 주입 역할 (M3-07 #52): 규범을 쓰지 않아 늘 0건
        mutator: 0,
        chat: 1,
        human: 0,
        orchestrator: 2,
      },
    });
    const labels = Object.fromEntries(
      CONFIRMATION_CRITERIA.map((c) => [c.id, c.options.map((o) => o.label)]),
    );
    expect(labels).toEqual({
      confirm: ['미확인', '확인 풀림', '확인됨'],
      kind: ['폐기', '대체', '테스트 변경', '규칙 신규', '요구사항'],
      risk: ['낮음', '보통', '높음'],
      author: [
        '규칙 작성',
        '계획',
        '테스트 작성',
        '구현',
        '변이 주입',
        '채팅',
        '사람',
        '오케스트레이터',
      ],
    });
    // 사람이 쓴 미확인 요구사항 · 오케스트레이터가 아닌 폐기 주체도 그 값으로 센다
    const human = { ...ITEM_REQ2, author: { kind: 'human' as const } };
    // 위험도 칸이 없는 항목(옛 규칙 · 요구사항)은 값이 없다
    expect(CONFIRMATION_CRITERIA[2]?.values(ITEM_RULE5)).toEqual([]);
    expect(CONFIRMATION_CRITERIA[2]?.values(ITEM_REQ2)).toEqual([]);
    expect(CONFIRMATION_CRITERIA[2]?.values(ITEM_TEST_1)).toEqual(['low']);
    const criterion = CONFIRMATION_CRITERIA[3];
    expect(criterion?.values(human)).toEqual(['human']);
    expect(criterion?.values({ ...ITEM_RETIRED, actor: { kind: 'orchestrator' } })).toEqual([
      'orchestrator',
    ]);
  });
});

describe('상세 값', () => {
  it('대체: 이전 · 이후 제목과 진술, 사유(숨은 글자 표기) · 근거, 생성 주체, 대상 · 대체 규칙 링크(대상은 폐기)', () => {
    const detail = confirmationDetail(ITEM_SUPERSEDED, []);
    expect(detail.diff).toEqual([
      { field: '제목', before: ITEM_SUPERSEDED.before.title, after: ITEM_SUPERSEDED.after.title },
      {
        field: '진술',
        before: ITEM_SUPERSEDED.before.statement,
        after: ITEM_SUPERSEDED.after.statement,
      },
    ]);
    expect(detail.rationale).toBe(RLO_RATIONALE_SHOWN);
    // 이미 표시 값인 근거는 바뀌지 않는다 (역슬래시가 둘이 되지 않음)
    expect(detail.grounds).toBe(SUPERSEDE_GROUNDS);
    expect(detail.author).toBe('에이전트 · 규칙 작성');
    expect(detail.links).toEqual([
      { label: '대상', entity: 'Rule', displayId: 'RULE-001', retired: true },
      { label: '대체 규칙', entity: 'Rule', displayId: 'RULE-003', retired: false },
    ]);
    expect(detail.files).toBeNull();
  });

  it('폐기: 이전 값만, 사유 없음, 읽지 못한 이전 내용은 "알 수 없음"', () => {
    const detail = confirmationDetail(ITEM_RETIRED, []);
    expect(detail.diff.map((row) => [row.field, row.before, row.after])).toEqual([
      ['제목', ITEM_RETIRED.before.title, null],
      ['진술', ITEM_RETIRED.before.statement, null],
    ]);
    expect(detail.rationale).toBeNull();
    expect(detail.grounds).toBe(ITEM_RETIRED.grounds);
    expect(confirmationDetail({ ...ITEM_RETIRED, before: null }, []).diff[0]?.before).toBe(
      '알 수 없음',
    );
  });

  it('미확인 규칙: 이후 값만(진술 · 사유는 그 규칙의 신규 기록에서), 신규 기록이 없으면 제목만', () => {
    const detail = confirmationDetail(ITEM_RULE5, FIXTURE_CHANGES);
    expect(detail.diff).toEqual([
      { field: '제목', before: null, after: ITEM_RULE5.text },
      { field: '진술', before: null, after: RULE5_STATEMENT },
    ]);
    expect(detail.rationale).toBe('REQ-001 본문의 시각 요구를 검사 가능한 규칙으로');
    expect(detail.links).toEqual([
      { label: '대상', entity: 'Rule', displayId: 'RULE-005', retired: false },
    ]);
    // 다른 규칙의 신규 기록은 쓰지 않는다
    const other = FIXTURE_CHANGES.filter((e) => e.targetRef.id !== ID.rule5);
    expect(confirmationDetail(ITEM_RULE5, other).diff).toEqual([
      { field: '제목', before: null, after: ITEM_RULE5.text },
    ]);
    expect(confirmationDetail(ITEM_RULE5, other).rationale).toBeNull();
  });

  it('요구사항: 본문 이후 값, 생성 주체는 그 역할, 링크는 요구사항', () => {
    const detail = confirmationDetail(ITEM_REQ2, FIXTURE_CHANGES);
    expect(detail.diff).toEqual([{ field: '본문', before: null, after: ITEM_REQ2.text }]);
    expect(detail.author).toBe('에이전트 · 채팅');
    expect(detail.links[0]).toMatchObject({ entity: 'Requirement', displayId: 'REQ-002' });
  });

  it('테스트 변경: 변경 내용 없이 바뀐 파일(경로 · 바뀜/지움) · 목록보다 많으면 전체 수 · 실행 · 오케스트레이터', () => {
    const detail = confirmationDetail(ITEM_TEST_2, []);
    expect(detail.diff).toEqual([]);
    expect(detail.files).toEqual([
      { path: ITEM_TEST_2.files[0].path, change: '바뀜' },
      { path: ITEM_TEST_2.files[1].path, change: '지움' },
    ]);
    expect(detail.fileCount).toBe('전체 3개 중 2개');
    expect(detail.run).toBe('EXE-003');
    expect(detail.author).toBe('오케스트레이터');
    expect(confirmationDetail(ITEM_TEST_1, []).fileCount).toBeNull();
    expect(confirmationDetail({ ...ITEM_TEST_1, runDisplayId: null }, []).run).toBe('알 수 없음');
    expect(
      confirmationDetail(
        { ...ITEM_TEST_1, files: [{ path: 'a\u202eb.ts', change: 'modified' }] },
        [],
      ).files?.[0]?.path,
    ).toBe('a\\u202eb.ts');
  });
});

describe('판단 카드', () => {
  it('그 대상들의 판단 기록만 순번 순으로: 모순 판단 · 모순 없음, 이의 판단 · 유지, 대체 항목은 새 규칙의 모순 판단', () => {
    const rule5 = judgmentCards(FIXTURE_CHANGES, judgmentTargets(ITEM_RULE5));
    expect(rule5.map((c) => [c.subject, c.verdict, c.grounds, c.actor])).toEqual([
      [
        '모순 판단',
        '모순 없음',
        '기존 효력 규칙 RULE-004와 동시에 만족 가능',
        '에이전트 · 규칙 작성',
      ],
      [
        '이의 판단',
        '유지',
        '이의 글의 주장은 진술 "응답 시각을 밀리초까지"와 맞지 않아 유지',
        '에이전트 · 규칙 작성',
      ],
    ]);
    const supersede = judgmentCards(FIXTURE_CHANGES, judgmentTargets(ITEM_SUPERSEDED));
    expect(supersede.map((c) => [c.subject, c.verdict, c.contradicts, c.grounds])).toEqual([
      ['모순 판단', '모순', ['RULE-001'], SUPERSEDE_GROUNDS],
    ]);
    expect(judgmentCards(FIXTURE_CHANGES, judgmentTargets(ITEM_RETIRED))).toEqual([]);
    // 같은 기록이 두 번 와도(대상마다 조회) 한 번
    expect(
      judgmentCards([...FIXTURE_CHANGES, ...FIXTURE_CHANGES], judgmentTargets(ITEM_RULE5)),
    ).toHaveLength(2);
  });

  const judgmentOf = (
    judgment: object,
    actor: NormChangeView['actor'] = { kind: 'orchestrator' },
  ) =>
    ({
      ...FIXTURE_CHANGES[1],
      actor,
      detail: { judgment },
    }) as unknown as NormChangeView;
  const input = { requirements: { total: 1, included: 1 }, rules: { total: 1, included: 1 } };

  it('주제 다섯 · 결과 다섯 · 판단 없음의 사정을 표시명으로, 모르는 값은 "알 수 없음"', () => {
    const subjects = NormJudgmentSubject.options.map(
      (subject) =>
        judgmentCard(judgmentOf({ subject, verdict: 'upheld', contradicts: [], input })).subject,
    );
    expect(subjects).toEqual([
      '모순 판단',
      '모순 판단',
      '이의 판단',
      '요구사항 변경 판단',
      '검사 실패 판단',
    ]);
    const verdicts = NormJudgmentVerdict.options.map(
      (verdict) =>
        judgmentCard(judgmentOf({ subject: 'objection', verdict, contradicts: [], input })).verdict,
    );
    expect(verdicts).toEqual(['모순 없음', '모순', '유지', '폐기', '대체']);
    const undecided = judgmentCard(
      judgmentOf({
        subject: 'check_failure',
        verdict: 'no_contradiction',
        contradicts: [],
        undecided: { endReason: 'error_max_budget_usd' },
        input,
      }),
    );
    expect([undecided.subject, undecided.verdict, undecided.undecided, undecided.actor]).toEqual([
      '검사 실패 판단',
      '모순 없음',
      '예산 한도 초과',
      '오케스트레이터',
    ]);
    const unknown = judgmentCard(
      judgmentOf({
        subject: 'future_subject',
        verdict: 'future_verdict',
        contradicts: [],
        undecided: { endReason: 'future_reason' },
        input,
      }),
    );
    expect([unknown.subject, unknown.verdict, unknown.undecided]).toEqual([
      '알 수 없음',
      '알 수 없음',
      '알 수 없음',
    ]);
    const missing = judgmentCard({ ...FIXTURE_CHANGES[1], detail: {} } as NormChangeView);
    expect([missing.subject, missing.verdict]).toEqual(['알 수 없음', '알 수 없음']);
  });
});

describe('판단 카드의 에이전트 글 표기', () => {
  it('근거 · 모순 대상에 숨은 글자 원문이 섞여 오면 표기로, 이미 표기된 글은 그대로', () => {
    const entry = {
      ...FIXTURE_CHANGES[1],
      reason: '근거 \u202e뒤집힘\u202c 끝 \\u200b',
      detail: {
        judgment: {
          subject: 'supersede',
          verdict: 'contradiction',
          contradicts: [{ id: ID.rule1, displayId: 'RULE-001\u200b' }],
          createdSeq: 1,
          input: { requirements: { total: 1, included: 1 }, rules: { total: 1, included: 1 } },
        },
      },
    } as NormChangeView;
    const card = judgmentCard(entry);
    expect(card.grounds).toBe('근거 \\u202e뒤집힘\\u202c 끝 \\u200b');
    expect(card.contradicts).toEqual(['RULE-001\\u200b']);
    for (const text of [card.grounds ?? '', ...card.contradicts]) {
      expect(/[\u200b\u202a-\u202e\u2066-\u2069]/.test(text)).toBe(false);
    }
  });
});

describe('[확인] 실패 문구', () => {
  it('-32009는 오류 없이 다시 읽기, 그 밖은 한 줄', () => {
    expect(isStaleConfirm({ code: -32009, message: '' })).toBe(true);
    expect(isStaleConfirm({ code: -32004, message: '' })).toBe(false);
    expect(confirmErrorText({ code: -32004, message: '' })).toBe('확인 실패 · 대상 없음');
    expect(confirmErrorText({ code: -32020, message: '' })).toBe('확인 실패 · 확인 권한 없음');
    expect(confirmErrorText({ code: -32603, message: '' })).toBe('확인 실패');
    expect(confirmErrorText(new Error('x'))).toBe('확인 실패');
  });
});

describe('배지 · 툴팁 (ADR-100 A7 · D8)', () => {
  // 검토 대기열이 빈 경우(검토 대기열을 더한 합계 · 툴팁은 test/todo-review-queue.test.ts)
  const noReview = { entries: [] };

  it('배지 = total, 툴팁은 자르기 전 종류별 수를 건수 많은 순으로', () => {
    expect(todoBadgeTotal(FIXTURE_LIST, noReview)).toBe(7);
    expect(todoBadgeTotal(null, noReview)).toBeNull();
    expect(todoBreakdown(FIXTURE_LIST, noReview)).toBe(
      '미확인 3 · 테스트 변경 2 · 폐기 1 · 대체 1',
    );
    expect(todoBreakdown(FIXTURE_LIST_AFTER_RULE4, noReview)).toBe('미확인 3 · 폐기 1 · 대체 1');
    expect(todoBreakdown(null, noReview)).toBe('');
    expect(todoBreakdown({ items: [], total: 0, truncated: false }, noReview)).toBe('');
  });

  it('잘린 목록: 종류별 수(totalByKind)가 있으면 그것으로(합 = 배지), 없으면 툴팁을 비운다', () => {
    const truncated = {
      items: [ITEM_SUPERSEDED],
      total: 250,
      truncated: true,
      totalByKind: { retired: 0, superseded: 1, test_changed: 0, unconfirmed_norm: 249 },
    };
    expect(todoBadgeTotal(truncated, noReview)).toBe(250);
    expect(todoBreakdown(truncated, noReview)).toBe('미확인 249 · 대체 1');
    expect(todoBreakdown({ ...truncated, totalByKind: undefined }, noReview)).toBe('');
    // 잘리지 않았으면 항목에서 센다
    expect(todoBreakdown({ ...FIXTURE_LIST, totalByKind: undefined }, noReview)).toBe(
      '미확인 3 · 테스트 변경 2 · 폐기 1 · 대체 1',
    );
  });
});
