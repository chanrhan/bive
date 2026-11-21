// 요구사항 상세의 규칙 작성 상태 (RPC `ruleWriter.status {projectId, requirementId}`, NFR-03: 값은 RPC 결과에서만, ADR-099).
// - 요구사항이 바뀌면 다시 읽고, 그동안은 아무것도 보이지 않는다(다른 요구사항의 상태를 보이지 않음)
// - 같은 요구사항의 수정 시각이 바뀌면(직접 편집 저장 = 다시 시도의 계기) 다시 읽는다
// - 이 프로젝트의 `event.ruleWriter.changed` · 재접속 때 다시 읽는다(useEventRefresh, 연속 알림은 합친다)
// - 늦게 온 이전 응답은 버린다. 조회 실패는 표시하지 않는다(상태 줄만 없고 상세의 나머지는 그대로)
import type { RuleWriterStatusEntry } from '@bive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { RULE_WRITER_EVENT_NAMES } from '../../runs/refreshCoalescer.js';
import { useEventRefresh } from '../../runs/useEventRefresh.js';

export const useRuleWriterStatus = (
  projectId: string,
  requirementId: string,
  updatedAt: string,
): RuleWriterStatusEntry | null => {
  const [loaded, setLoaded] = useState<{
    requirementId: string;
    entry: RuleWriterStatusEntry | null;
  } | null>(null);
  // 마지막으로 보낸 요청 번호: 늦게 온 이전 응답을 버린다
  const latest = useRef(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refresh = useCallback((): Promise<void> => {
    latest.current += 1;
    const ticket = latest.current;
    return window.bive.invoke('ruleWriter.status', { projectId, requirementId }).then(
      ({ entries }) => {
        if (!live.current || ticket !== latest.current) return;
        const entry = entries.find((item) => item.requirementId === requirementId) ?? null;
        setLoaded({ requirementId, entry });
      },
      () => undefined,
    );
  }, [projectId, requirementId]);

  useEffect(() => {
    void refresh();
    // 수정 시각은 다시 읽는 계기로만 쓴다
  }, [refresh, updatedAt]);

  useEventRefresh(projectId, RULE_WRITER_EVENT_NAMES, refresh);

  return loaded !== null && loaded.requirementId === requirementId ? loaded.entry : null;
};
