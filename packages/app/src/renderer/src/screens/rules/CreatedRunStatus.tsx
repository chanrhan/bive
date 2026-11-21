// 규칙 화면에서 [실행]으로 만든 실행의 "표시 ID · 상태" (screens.md SCR-03 · 1.1, ADR-100 B⑥ · ADR-105).
// - 규칙 상세 머리줄 아래 한 줄에 둔다(머리줄의 폭을 먹지 않게, #218 검토). 예: 진행 중인 실행이 있으면 "EXE-004 · 실행 대기"
// - 처음 값은 `run.create` 응답의 상태이고, 실행 알림 · 재접속 때 `run.get`으로 다시 읽은 상태로 바꾼다(NFR-03)
import type { RunStatus } from '@bive/shared';
import { useCallback, useState } from 'react';

import { useRunEventRefresh } from '../../runs/useRunEventRefresh.js';
import { RUN_STATUS_TEXT } from '../verification/verificationView.js';
import type { CreatedRun } from './RunStart.js';

export interface CreatedRunStatusProps {
  projectId: string;
  run: CreatedRun;
}

/** 만든 실행이 바뀌면 상태를 새로 시작하도록 호출하는 쪽이 `key={run.id}`를 준다. */
export const CreatedRunStatus = ({ projectId, run }: CreatedRunStatusProps): React.JSX.Element => {
  const [status, setStatus] = useState<RunStatus>(run.status);
  const refresh = useCallback(async () => {
    const { run: latest } = await window.bive.invoke('run.get', { projectId, id: run.id });
    setStatus(latest.status);
  }, [projectId, run.id]);
  useRunEventRefresh(projectId, refresh);

  return (
    <p className="run-start-created" data-testid="run-start-created" data-status={status}>
      {`${run.displayId} · ${RUN_STATUS_TEXT[status]}`}
    </p>
  );
};
