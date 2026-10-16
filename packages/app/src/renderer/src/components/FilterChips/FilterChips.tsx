// 기준별 필터 칩 (screens.md 1.4 목록): 기준 하나 = 칩 하나. 칩을 누르면 값 목록(여러 개 선택 = OR)이 열리고
// 값마다 개수를 보이며 0건 값은 비활성이다. 고른 값은 칩에 표시하고 ×로 그 기준을 해제한다.
// 기준의 값이 전부 0건이면 칩 자체가 비활성이다 (ADR-035: 기준은 보이되 0건 비활성).
import './FilterChips.css';

import { ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { FilterCriterion, FilterState, OptionCounts } from '../ListView/filter.js';

/** 칩이 쓰는 기준 정보 (항목 값 함수는 필요 없다). */
export type ChipCriterion = Pick<FilterCriterion<never>, 'id' | 'label' | 'options'>;

export interface FilterChipsProps {
  criteria: readonly ChipCriterion[];
  selected: FilterState['selected'];
  counts: OptionCounts;
  onToggle: (criterionId: string, value: string) => void;
  onClear: (criterionId: string) => void;
}

export const FilterChips = ({
  criteria,
  selected,
  counts,
  onToggle,
  onClear,
}: FilterChipsProps): React.JSX.Element | null => {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  // 바깥을 누르면 닫는다
  useEffect(() => {
    if (openId === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) {
        setOpenId(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [openId]);

  if (criteria.length === 0) return null;

  return (
    <div
      className="filter-chips"
      role="group"
      aria-label="필터"
      ref={rootRef}
      // 초점이 칩 묶음 밖의 다른 요소(검색 입력 등)로 옮겨 가면 닫는다 (키보드 사용 포함).
      // 초점 받을 요소가 없는 곳(메뉴 안 글자 등)을 누른 경우는 relatedTarget이 null이라 닫지 않고
      // 바깥 누르기는 pointerdown 처리기가 맡는다
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) setOpenId(null);
      }}
    >
      {criteria.map((criterion) => {
        const chosen = selected[criterion.id] ?? [];
        const byValue = counts[criterion.id] ?? {};
        const empty = criterion.options.every((option) => (byValue[option.value] ?? 0) === 0);
        const disabled = empty && chosen.length === 0;
        const open = openId === criterion.id && !disabled;
        const chosenLabels = criterion.options
          .filter((option) => chosen.includes(option.value))
          .map((option) => option.label);
        const text =
          chosenLabels.length === 0
            ? criterion.label
            : `${criterion.label}: ${chosenLabels.join(', ')}`;
        const menuId = `${baseId}-${criterion.id}`;
        return (
          <div
            key={criterion.id}
            className="filter-chip"
            data-testid={`filter-chip-${criterion.id}`}
            data-selected={chosen.length > 0 ? 'true' : 'false'}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && open) {
                event.stopPropagation();
                setOpenId(null);
                event.currentTarget
                  .querySelector<HTMLButtonElement>('.filter-chip-button')
                  ?.focus();
              }
            }}
          >
            <button
              type="button"
              className="filter-chip-button"
              data-testid="filter-chip-button"
              aria-haspopup="true"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              disabled={disabled}
              title={text}
              onClick={() => setOpenId(open ? null : criterion.id)}
            >
              <span className="filter-chip-text">{text}</span>
              <ChevronDown className="inline-icon" aria-hidden="true" />
            </button>
            {chosen.length > 0 && (
              <button
                type="button"
                className="filter-chip-clear"
                data-testid="filter-chip-clear"
                aria-label={`${criterion.label} 해제`}
                title={`${criterion.label} 해제`}
                onClick={() => onClear(criterion.id)}
              >
                <X className="inline-icon" aria-hidden="true" />
              </button>
            )}
            {open && (
              <div
                id={menuId}
                className="filter-menu"
                data-testid="filter-menu"
                role="group"
                aria-label={criterion.label}
              >
                {criterion.options.map((option) => {
                  const count = byValue[option.value] ?? 0;
                  const checked = chosen.includes(option.value);
                  return (
                    <label
                      key={option.value}
                      className="filter-option"
                      data-testid="filter-option"
                      data-value={option.value}
                      data-disabled={count === 0 && !checked ? 'true' : 'false'}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={count === 0 && !checked}
                        onChange={() => onToggle(criterion.id, option.value)}
                      />
                      <span className="filter-option-label">{option.label}</span>
                      <span className="filter-count" data-testid="filter-count">
                        {count}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
