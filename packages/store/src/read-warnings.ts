// 저장된 행을 읽을 때의 경고 로그 (ADR-094). 조회마다 같은 경고가 쌓이지 않게 같은 대상 · 같은 값이면 프로세스당 한 번만 찍는다.
// - 대상(`key`)은 프로젝트 ID와 무엇을 읽었는지로 정하고, 값(`value`)이 바뀌면(다른 저장 값 · 다른 건수) 다시 한 번 찍는다
// - 로그에는 저장된 값을 싣지 않는다: 오케스트레이터가 정한 문장 · 프로젝트 ID(ULID) · 건수만 쓴다(줄바꿈 등으로 로그 줄을 꾸밀 수 없다)

const warned = new Map<string, string>();

/** 같은 `key`에 같은 `value`로 이미 찍었으면 아무것도 하지 않고, 아니면 `console.warn` 한 줄. 찍었는지 돌려준다. */
export const warnOnce = (key: string, value: string, message: string): boolean => {
  if (warned.get(key) === value) return false;
  warned.set(key, value);
  console.warn(message);
  return true;
};
