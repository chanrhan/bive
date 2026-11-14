// 검증 화면 (screens.md SCR-05): 머리줄 · 지표 카드 · 파이프라인 · 규칙별 최신 판정 목록.
// - 값은 verification.summary 결과에서만 그린다(NFR-03). 표시 규칙은 verificationView.ts
// - 지표 카드는 준수 · 실행당 비용만. 잠정 · 변이 · 규칙화 불가 · 추적성 결함 카드, 준수 추이 그래프, 코드 열람 영역은
//   기능 이슈 전까지 미노출 (ADR-035)
// - 준수 카드 → 규칙 화면 `준수 집계: 판정 가능` 필터 (분모 목록, JDG-03)
// - 파이프라인 = 최근 실행의 단계 순서와 현재 단계. 중단이면 [재개] → run.resume (ADR-011)
// - 상태(ADR-072, ADR-060과 같은 방식): 프로젝트 조회 중 = 비움 · 프로젝트 없음 = "프로젝트 없음" ·
//   로딩 = 자리 비움(문구 · 스켈레톤 없음) · 불러오기 실패 = "검증 불러오기 실패" · 실행 없음 = 파이프라인 자리 "실행 없음"(ADR-029)
import './VerificationScreen.css';

import type {
  VerificationPipeline,
  VerificationRuleRow,
  VerificationSummaryResult,
} from '@bive/shared';
import { useCallback, useState } from 'react';

import { setListFilter } from '../../components/ListView/filterStore.js';
import { StatusBadge } from '../../components/StatusBadge/StatusBadge.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { useNavigation } from '../../navigation/NavigationContext.js';
import { useProject } from '../../project/ProjectContext.js';
import { RULES_LIST_ID } from '../rules/rulesView.js';
import { useVerification } from './useVerification.js';
import {
  basisText,
  canResume,
  COMPLIANCE_FILTER,
  complianceText,
  formatUsd,
  RUN_STATUS_TEXT,
  runLinkParts,
  STEP_LABELS,
  STEP_STATUS_TEXT,
  TEXT,
} from './verificationView.js';

export const VerificationScreen = (): React.JSX.Element => {
  const { project, loading } = useProject();
  if (project === null) {
    return (
      <div
        className="verification-screen"
        data-testid="verification-screen"
        data-state={loading ? 'project-loading' : 'no-project'}
      >
        {!loading && <EmptyState text={TEXT.noProject} />}
      </div>
    );
  }
  return <VerificationBody key={project.id} projectId={project.id} />;
};

const VerificationBody = ({ projectId }: { projectId: string }): React.JSX.Element => {
  const { load, reload } = useVerification(projectId);
  return (
    <div className="verification-screen" data-testid="verification-screen" data-state={load.state}>
      {load.state === 'loading' && (
        <div className="verification-loading" data-testid="verification-loading" aria-busy="true" />
      )}
      {load.state === 'error' && (
        <p className="empty-state" data-testid="verification-load-error" role="alert">
          {TEXT.loadFailed}
        </p>
      )}
      {load.state === 'ready' && (
        <VerificationContent projectId={projectId} summary={load.summary} onChanged={reload} />
      )}
    </div>
  );
};

const VerificationContent = ({
  projectId,
  summary,
  onChanged,
}: {
  projectId: string;
  summary: VerificationSummaryResult;
  onChanged: () => void;
}): React.JSX.Element => {
  const { navigate } = useNavigation();
  const openDenominator = useCallback(() => {
    setListFilter(RULES_LIST_ID, COMPLIANCE_FILTER);
    navigate('rules');
  }, [navigate]);

  return (
    <div className="verification-content">
      <p
        className="verification-basis"
        data-testid="verification-basis"
        {...(summary.basis !== null && { title: summary.basis.commit })}
      >
        {basisText(summary.basis)}
      </p>
      <section className="verification-metrics" aria-label={TEXT.metrics}>
        <button
          type="button"
          className="metric-card"
          data-testid="metric-compliance"
          title={TEXT.complianceHint}
          onClick={openDenominator}
        >
          <span className="metric-label" data-testid="metric-label">
            {TEXT.compliance}
          </span>
          <span className="metric-value" data-testid="metric-value">
            {complianceText(summary.compliance)}
          </span>
        </button>
        <div className="metric-card" data-testid="metric-cost-per-run">
          <span className="metric-label" data-testid="metric-label">
            {TEXT.costPerRun}
          </span>
          <span className="metric-value" data-testid="metric-value">
            {formatUsd(summary.costPerRunUsd)}
          </span>
        </div>
      </section>
      <section className="verification-pipeline" data-testid="pipeline" aria-label={TEXT.pipeline}>
        <h2 className="verification-heading">{TEXT.pipeline}</h2>
        {summary.pipeline === null ? (
          <EmptyState text={TEXT.noRun} />
        ) : (
          <Pipeline projectId={projectId} pipeline={summary.pipeline} onChanged={onChanged} />
        )}
      </section>
      <section
        className="verification-rules"
        data-testid="verification-rules"
        aria-label={TEXT.rules}
      >
        <h2 className="verification-heading">{TEXT.rules}</h2>
        {summary.rules.length === 0 ? (
          <EmptyState text={TEXT.noRules} />
        ) : (
          <ul className="verification-rule-list">
            {summary.rules.map((row) => (
              <RuleRow key={row.rule.id} row={row} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

const Pipeline = ({
  projectId,
  pipeline,
  onChanged,
}: {
  projectId: string;
  pipeline: VerificationPipeline;
  onChanged: () => void;
}): React.JSX.Element => {
  const { run, stages } = pipeline;
  const [resume, setResume] = useState<'idle' | 'pending' | 'failed'>('idle');

  const onResume = useCallback(() => {
    setResume('pending');
    window.bive.invoke('run.resume', { projectId, id: run.id, author: { kind: 'human' } }).then(
      () => {
        setResume('idle');
        onChanged();
      },
      () => setResume('failed'),
    );
  }, [projectId, run.id, onChanged]);

  return (
    <div className="pipeline" data-run-status={run.status}>
      <div className="pipeline-head">
        <span className="pipeline-run" data-testid="pipeline-run">
          {run.displayId}
        </span>
        <span
          className="pipeline-run-status"
          data-testid="pipeline-run-status"
          data-status={run.status}
        >
          {RUN_STATUS_TEXT[run.status]}
        </span>
        {run.currentStep !== null && (
          <span className="pipeline-current" data-testid="pipeline-current">
            {STEP_LABELS[run.currentStep]}
          </span>
        )}
        {canResume(run.status) && (
          <button
            type="button"
            className="pipeline-resume"
            data-testid="pipeline-resume"
            disabled={resume === 'pending'}
            onClick={onResume}
          >
            {TEXT.resume}
          </button>
        )}
        {resume === 'failed' && (
          <span className="pipeline-resume-error" data-testid="pipeline-resume-error" role="alert">
            {TEXT.resumeFailed}
          </span>
        )}
      </div>
      <ol className="pipeline-stepper" data-testid="pipeline-stepper">
        {stages.map((stage) => {
          const current = run.currentStep === stage.kind;
          return (
            <li
              key={stage.kind}
              className="pipeline-stage"
              data-testid="pipeline-stage"
              data-kind={stage.kind}
              data-status={stage.status}
              {...(current && { 'aria-current': 'step' as const })}
              title={`${STEP_LABELS[stage.kind]} · ${STEP_STATUS_TEXT[stage.status]}`}
            >
              <span className="pipeline-dot" aria-hidden="true" />
              <span className="pipeline-label">{STEP_LABELS[stage.kind]}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

const RuleRow = ({ row }: { row: VerificationRuleRow }): React.JSX.Element => {
  const link = row.run === null ? null : runLinkParts(row.run);
  return (
    <li className="verification-rule" data-testid="verification-rule" data-rule-id={row.rule.id}>
      <StatusBadge kind="judgment" status={row.judgment.status} />
      <span className="verification-rule-title" data-testid="verification-rule-title">
        {row.rule.title}
      </span>
      <span className="verification-rule-id" data-testid="verification-rule-id">
        {row.rule.displayId}
      </span>
      {link !== null && (
        <span className="run-link" data-testid="run-link">
          <span data-testid="run-link-id">{link.id}</span>
          <span data-testid="run-link-cost">{link.cost}</span>
          <span data-testid="run-link-turns">{link.turns}</span>
        </span>
      )}
    </li>
  );
};
