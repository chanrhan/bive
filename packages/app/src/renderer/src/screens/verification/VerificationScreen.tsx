// 검증 화면 (screens.md SCR-05): 머리줄 · 지표 카드 · 코드 열람 · 파이프라인 · 규칙별 최신 판정 목록.
// - 값은 verification.summary · codeOpen.summary 결과에서만 그린다(NFR-03). 표시 규칙은 verificationView.ts
// - 지표 카드는 준수(전체 기준 · 사람 확인 기준) · 에이전트 폐기 규칙 · 규칙화 불가 비율 · 추적성 결함 · 실행당 비용 (ADR-100 D7 ·
//   B⑦, ADR-117 · ADR-137). 잠정 · 변이 카드, 준수 추이 그래프는 기능 이슈 전까지 미노출 (ADR-035)
// - 규칙화 불가 비율 · 추적성 결함 카드 → 요구사항 화면 `상태: 규칙화 불가` · `상태: 추적성 결함` (SCR-05 이동 경로, ADR-137)
// - 코드 열람 = 열람 사유 분포(MET-01, M2-02 · ADR-088): 사유 3종의 건수, 기록이 없으면 '없음'. 검증 요약과 따로 불러
//   이 영역의 로딩 · 실패는 이 영역 안에서만 보인다(로딩 = 자리 비움, 실패 = "코드 열람 불러오기 실패")
// - 준수 카드의 전체 기준 → 규칙 화면 `준수 집계: 판정 가능` 필터 (분모 목록, JDG-03), 사람 확인 기준 → `준수 집계: 판정 가능`
//   + `확인: 확인됨`, 에이전트 폐기 규칙 카드 → [폐기 포함] (ADR-117)
// - 파이프라인 = 보일 실행(자리를 차지한 실행, 없으면 최근 실행, ADR-105)의 단계 순서와 현재 단계, 생략 단계는 흐림 + 보이는 "생략"(#165). 중단이면 [재개] → run.resume (ADR-011)
// - 실행 알림(event.run.updated · event.step.updated)을 받으면 요약을 다시 읽는다(useVerification, ADR-076)
// - 상태(ADR-072, ADR-060과 같은 방식): 프로젝트 조회 중 = 비움 · 프로젝트 없음 = "프로젝트 없음" ·
//   로딩 = 자리 비움(문구 · 스켈레톤 없음) · 불러오기 실패 = "검증 불러오기 실패" · 실행 없음 = 파이프라인 자리 "실행 없음"(ADR-029)
import './VerificationScreen.css';

import type {
  CodeOpenSummaryResult,
  VerificationPipeline,
  VerificationRuleRow,
  VerificationSummaryResult,
} from '@bive/shared';
import { useCallback, useState } from 'react';

import type { FilterState } from '../../components/ListView/filter.js';
import { setListFilter } from '../../components/ListView/filterStore.js';
import { StatusBadge } from '../../components/StatusBadge/StatusBadge.js';
import { tooltipTrigger } from '../../components/Tooltip/tooltipStore.js';
import { visibleText } from '../../components/VisibleText/visibleText.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { useNavigation } from '../../navigation/NavigationContext.js';
import { useProject } from '../../project/ProjectContext.js';
import { REQUIREMENTS_LIST_ID, requirementStatusFilter } from '../requirements/requirementsView.js';
import { RULES_LIST_ID } from '../rules/rulesView.js';
import { type CodeOpenSummaryLoad, useCodeOpenSummary } from './useCodeOpenSummary.js';
import { useVerification } from './useVerification.js';
import {
  AGENT_RETIRED_FILTER,
  agentRetiredText,
  basisText,
  canResume,
  codeOpenRows,
  COMPLIANCE_FILTER,
  complianceText,
  CONFIRMED_COMPLIANCE_FILTER,
  confirmedComplianceState,
  confirmedComplianceText,
  currentStepOf,
  formatUsd,
  isResumeUnrecoverable,
  queuedText,
  resumeEndedStatus,
  resumeUnrecoverableText,
  RUN_STATUS_TEXT,
  runLinkParts,
  STEP_LABELS,
  STEP_STATUS_TEXT,
  TEXT,
  traceabilityCount,
  traceabilityHint,
  unrulableText,
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
  // 코드 열람은 검증 요약과 같은 때 따로 부르기 시작한다(영역은 요약이 준비된 뒤 보인다). 알림 · 재접속 때는 함께 다시 부른다
  const { load: codeOpen, refresh: refreshCodeOpen } = useCodeOpenSummary(projectId);
  const { load, reload } = useVerification(projectId, refreshCodeOpen);
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
        <VerificationContent
          projectId={projectId}
          summary={load.summary}
          codeOpen={codeOpen}
          onChanged={reload}
        />
      )}
    </div>
  );
};

const VerificationContent = ({
  projectId,
  summary,
  codeOpen,
  onChanged,
}: {
  projectId: string;
  summary: VerificationSummaryResult;
  codeOpen: CodeOpenSummaryLoad;
  onChanged: () => void;
}): React.JSX.Element => {
  const { navigate } = useNavigation();
  const openRules = useCallback(
    (filter: FilterState) => {
      setListFilter(RULES_LIST_ID, filter);
      navigate('rules');
    },
    [navigate],
  );
  // 규칙화 불가 · 추적성 결함 카드: 요구사항 목록을 그 상태 칩 하나로 연다(앞 필터는 남지 않는다)
  const openRequirements = useCallback(
    (status: 'traceability' | 'unrulable') => {
      setListFilter(REQUIREMENTS_LIST_ID, requirementStatusFilter(status));
      navigate('requirements');
    },
    [navigate],
  );
  const confirmedState = confirmedComplianceState(summary.confirmedCompliance);

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
        {/* 준수 카드: 두 기준을 함께 보이고 기준마다 그 분모 목록으로 이동한다 (ADR-100 D7, ADR-117). 기준의 한계 문구는 공통
            툴팁(올림 · 키보드 초점)이고 누름은 원래 동작(이동)만 한다 (#201 · ADR-124) */}
        <div
          className="metric-card metric-card-group"
          data-testid="metric-compliance"
          role="group"
          aria-labelledby="metric-compliance-label"
        >
          <span className="metric-label" data-testid="metric-label" id="metric-compliance-label">
            {TEXT.compliance}
          </span>
          <div className="metric-parts">
            <button
              type="button"
              className="metric-part"
              data-testid="metric-compliance-all"
              {...tooltipTrigger(TEXT.complianceHint, 'action')}
              onClick={() => openRules(COMPLIANCE_FILTER)}
            >
              <span className="metric-part-label" data-testid="metric-part-label">
                {TEXT.complianceAll}
              </span>{' '}
              <span className="metric-value" data-testid="metric-value">
                {complianceText(summary.compliance)}
              </span>
            </button>
            <button
              type="button"
              className="metric-part"
              data-testid="metric-compliance-confirmed"
              data-state={confirmedState}
              {...tooltipTrigger(TEXT.complianceConfirmedHint, 'action')}
              onClick={() => openRules(CONFIRMED_COMPLIANCE_FILTER)}
            >
              <span className="metric-part-label" data-testid="metric-part-label">
                {TEXT.complianceConfirmed}
              </span>{' '}
              <span className="metric-value" data-testid="metric-value">
                {confirmedComplianceText(summary.confirmedCompliance)}
              </span>
            </button>
          </div>
        </div>
        <button
          type="button"
          className="metric-card"
          data-testid="metric-agent-retired"
          title={TEXT.agentRetiredHint}
          onClick={() => openRules(AGENT_RETIRED_FILTER)}
        >
          <span className="metric-label" data-testid="metric-label">
            {TEXT.agentRetired}
          </span>{' '}
          <span className="metric-value" data-testid="metric-value">
            {agentRetiredText(summary.agentRetiredRules)}
          </span>
        </button>
        <button
          type="button"
          className="metric-card"
          data-testid="metric-unrulable"
          data-state={summary.unrulable.total === 0 ? 'none' : 'value'}
          {...tooltipTrigger(TEXT.unrulableHint, 'action')}
          onClick={() => openRequirements('unrulable')}
        >
          <span className="metric-label" data-testid="metric-label">
            {TEXT.unrulable}
          </span>{' '}
          <span className="metric-value" data-testid="metric-value">
            {unrulableText(summary.unrulable)}
          </span>
        </button>
        <button
          type="button"
          className="metric-card"
          data-testid="metric-traceability"
          {...tooltipTrigger(traceabilityHint(summary.traceability), 'action')}
          onClick={() => openRequirements('traceability')}
        >
          <span className="metric-label" data-testid="metric-label">
            {TEXT.traceability}
          </span>{' '}
          <span className="metric-value" data-testid="metric-value">
            {String(traceabilityCount(summary.traceability))}
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
      <CodeOpenArea load={codeOpen} />
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

const CodeOpenArea = ({ load }: { load: CodeOpenSummaryLoad }): React.JSX.Element => (
  <section className="verification-code-open" data-testid="code-open" aria-label={TEXT.codeOpen}>
    <h2 className="verification-heading">
      {/* 한계 문구는 준수 카드처럼 초점을 받는 버튼의 공통 툴팁(설명)에 둔다. 키보드 초점 · 올림으로 열리고, 원래 동작이 없는
          버튼이라 누름(Enter · Space)으로도 연다 (ADR-088, #191 · #201 · ADR-124) */}
      <button
        type="button"
        className="verification-hint"
        data-testid="code-open-hint"
        {...tooltipTrigger(TEXT.codeOpenHint, 'press')}
      >
        {TEXT.codeOpen}
      </button>
    </h2>
    {load.state === 'loading' && (
      <div className="code-open-loading" data-testid="code-open-loading" aria-busy="true" />
    )}
    {load.state === 'error' && (
      <p className="code-open-error" data-testid="code-open-load-error" role="alert">
        {TEXT.codeOpenLoadFailed}
      </p>
    )}
    {load.state === 'ready' && <CodeOpenValue summary={load.summary} />}
  </section>
);

const CodeOpenValue = ({ summary }: { summary: CodeOpenSummaryResult }): React.JSX.Element => {
  const rows = codeOpenRows(summary);
  if (rows === null) {
    return (
      <p className="code-open-none" data-testid="code-open-none">
        {TEXT.none}
      </p>
    );
  }
  return (
    <ul className="code-open-reasons">
      {rows.map(({ reason, label, count }) => (
        <li
          key={reason}
          className="code-open-reason"
          data-testid="code-open-reason"
          data-reason={reason}
        >
          <span className="code-open-label" data-testid="code-open-label">
            {label}
          </span>{' '}
          <span className="code-open-count" data-testid="code-open-count">
            {count}
          </span>
        </li>
      ))}
    </ul>
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
  const currentStep = currentStepOf(run);
  const queued = queuedText(pipeline.queued);
  // 'failed' = 재개 실패(실행은 중단 그대로), 'ended' = 재개할 수 없어 실행이 실패로 끝남(그 실행의 표시 ID, ADR-105)
  const [resume, setResume] = useState<
    'idle' | 'pending' | 'failed' | { ended: string; status: string | null }
  >('idle');

  const onResume = useCallback(() => {
    setResume('pending');
    window.bive.invoke('run.resume', { projectId, id: run.id, author: { kind: 'human' } }).then(
      () => {
        setResume('idle');
        onChanged();
      },
      (error: unknown) => {
        if (isResumeUnrecoverable(error)) {
          // 실행이 끝나 자리가 났으므로 다시 읽는다(다음 실행 대기가 보인다)
          setResume({ ended: run.displayId, status: resumeEndedStatus(error) });
          onChanged();
          return;
        }
        setResume('failed');
      },
    );
  }, [projectId, run.id, run.displayId, onChanged]);
  const resumeError =
    resume === 'failed'
      ? TEXT.resumeFailed
      : typeof resume === 'object'
        ? resumeUnrecoverableText(resume.ended, resume.status)
        : null;

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
        {currentStep !== null && (
          <span className="pipeline-current" data-testid="pipeline-current">
            {STEP_LABELS[currentStep]}
          </span>
        )}
        {queued !== null && (
          <span className="pipeline-queued" data-testid="pipeline-queued">
            {queued}
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
        {resumeError !== null && (
          <span className="pipeline-resume-error" data-testid="pipeline-resume-error" role="alert">
            {resumeError}
          </span>
        )}
      </div>
      <ol className="pipeline-stepper" data-testid="pipeline-stepper">
        {stages.map((stage) => {
          const current = currentStep === stage.kind;
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
              {/* 생략 단계 흐림 + "생략" (screens.md 파이프라인 스테퍼): 툴팁만이 아니라 보이는 글자 (#165) */}
              {stage.status === 'skipped' && (
                <span className="pipeline-skip" data-testid="pipeline-skip">
                  {STEP_STATUS_TEXT.skipped}
                </span>
              )}
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
      {/* 에이전트가 쓴 제목: 숨은 글자를 보이는 표기로 (ADR-114 · ADR-117) */}
      <span className="verification-rule-title" data-testid="verification-rule-title">
        {visibleText(row.rule.title)}
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
