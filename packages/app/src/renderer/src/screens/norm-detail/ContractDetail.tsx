// 계약 상세 (screens.md SCR-04 표시 · SCR-06 규범 상세, M3-05 #50 · ADR-133). 계약 목록 + 상세 2단의 상세 영역(별도 화면 아님).
// - 머리: 원본 파일 · 표시 ID. 속성 줄: 종류 · 원본 파일 · 연결 규칙 · 판정 · 부모 요구사항 · 생성 주체 · 확인 상태
// - 연결 규칙은 `contract` 검사 규칙의 표시 ID이고, 놓는 화면이 `onOpenRule`을 주면 누르면 그 규칙으로 간다. 없으면 "없음"
// - 판정은 그 검사 규칙의 최신 판정(판정 기록이 없으면 미판정), 검사 규칙이 없거나 판정을 모르면 "없음"
// - 부모 요구사항은 있으면 requirement.get의 표시 ID(조회 실패면 줄을 숨김, 규칙 상세와 같음), 없으면 "없음"
// - 확인 상태는 보이기만 한다([확인] 없음: 확인 RPC가 계약을 받지 않는다, ADR-129 ② · ADR-133)
// - 원본 파일은 숨은 글자를 보이는 표기로 그린다(visibleText). 값은 contract.list · rule.list · requirement.get 결과에서만 (NFR-03)
import './RuleDetail.css';

import { AuthorMark } from '../../components/AuthorMark/AuthorMark.js';
import { CONFIRMATION_LABELS } from '../../components/StatusBadge/status.js';
import { visibleText } from '../../components/VisibleText/visibleText.js';
import {
  type ContractItem,
  contractKindLabel,
  judgmentText,
  TEXT,
} from '../contracts/contractsView.js';
import { ruleAuthorName } from './ruleDetailView.js';
import { useRuleParent } from './useRuleDetailData.js';

export interface ContractDetailProps {
  projectId: string;
  item: ContractItem;
  /** 연결 규칙의 상세로 간다. 없으면 규칙 표시 ID는 글자만 */
  onOpenRule?: (rule: { id: string; displayId: string }) => void;
}

/** 계약이 바뀌면 불러온 값을 새로 시작하도록 호출하는 쪽이 `key={contract.id}`를 준다. */
export const ContractDetail = ({
  projectId,
  item,
  onOpenRule,
}: ContractDetailProps): React.JSX.Element => {
  const { contract, rule, judgment } = item;
  const parent = useRuleParent(projectId, contract.parentRequirementId);
  const file = visibleText(contract.sourceFile);

  return (
    <div
      className="rule-detail-body"
      data-testid="contract-detail-body"
      data-contract-id={contract.id}
    >
      <header className="rule-detail-head">
        <h2 className="rule-detail-title" data-testid="contract-detail-title">
          {file}
        </h2>
        <span className="rule-detail-id" data-testid="contract-detail-id">
          {contract.displayId}
        </span>
      </header>
      <dl className="rule-fields">
        <Field id="kind" label={TEXT.kind}>
          <span data-kind={contract.kind}>{contractKindLabel(contract.kind)}</span>
        </Field>
        <Field id="source" label={TEXT.sourceFile}>
          <span className="rule-detail-text">{file}</span>
        </Field>
        <Field id="rule" label={TEXT.rule}>
          {rule === null ? (
            TEXT.none
          ) : onOpenRule === undefined ? (
            <span data-testid="contract-rule-ref">{rule.displayId}</span>
          ) : (
            <button
              type="button"
              className="rule-ref-link"
              data-testid="contract-rule-ref"
              data-rule-id={rule.id}
              onClick={() => onOpenRule(rule)}
            >
              {rule.displayId}
            </button>
          )}
        </Field>
        <Field id="judgment" label={TEXT.judgment}>
          <span data-status={judgment ?? ''}>{judgmentText(judgment)}</span>
        </Field>
        {contract.parentRequirementId === null ? (
          <Field id="parent" label={TEXT.parent}>
            {TEXT.none}
          </Field>
        ) : (
          parent !== null && (
            <Field id="parent" label={TEXT.parent}>
              {parent.displayId}
            </Field>
          )
        )}
        <Field id="author" label={TEXT.author}>
          <AuthorMark
            kind={contract.author.kind}
            showLabel
            name={ruleAuthorName(contract.author)}
          />
        </Field>
        <Field id="confirmation" label={TEXT.confirmation}>
          <span data-state={contract.confirmation.state}>
            {CONFIRMATION_LABELS[contract.confirmation.state]}
          </span>
        </Field>
      </dl>
    </div>
  );
};

const Field = ({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element => (
  <div className="rule-field" data-testid={`contract-field-${id}`}>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);
