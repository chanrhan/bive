// 수정 입력 초안 (#165 M1-37, ADR-082): 사람이 [수정]으로 고친 문장을 제안별로 기억한다.
// - 초안이 있으면 그 제안의 수정 입력이 열려 있는 것이다. 다른 카드 선택 · 필터 전환 · 화면 이동 · 목록 다시 읽기로
//   상세가 다시 그려져도 고친 내용이 남고, 그 제안으로 돌아오면 수정 입력이 그 내용으로 다시 열린다
// - 지우는 때: 사람이 [버리기]로 확인했을 때 · 그 제안의 처리 요청(승인 · 수정 후 승인 · 거절)이 성공했을 때
// - 렌더러 모듈 메모리에만 둔다(tabStore와 같음): 앱 재시작 때 초기화, 디스크에 쓰지 않음
import type { EditValues } from './proposalDetailView.js';

const drafts = new Map<string, EditValues>();

const keyOf = (projectId: string, proposalId: string): string => `${projectId}/${proposalId}`;

/** 제안의 수정 초안. 수정 입력이 닫혀 있으면 null. */
export const getEditDraft = (projectId: string, proposalId: string): EditValues | null =>
  drafts.get(keyOf(projectId, proposalId)) ?? null;

/** 수정 초안을 저장한다 (입력이 열릴 때 · 고칠 때마다). */
export const setEditDraft = (projectId: string, proposalId: string, values: EditValues): void => {
  drafts.set(keyOf(projectId, proposalId), { ...values });
};

/** 수정 초안을 지운다 (수정 입력이 닫힘). */
export const clearEditDraft = (projectId: string, proposalId: string): void => {
  drafts.delete(keyOf(projectId, proposalId));
};
