// 프로젝트별 DB(`$BIVE_HOME/projects/<projectId>/bive.db`)의 마이그레이션 목록.
// 새 마이그레이션은 이 폴더에 `<NNNN>_<name>.ts`(다음 번호, 4자리)로 추가하고 아래 배열 끝에 넣는다.
// 머지된 파일은 고치지 않는다 (적용 기록의 SQL 해시와 달라지면 DB를 열지 않는다).
import type { Migration } from '../../migrate.js';
import { migration as m0001 } from './0001_projects.js';
import { migration as m0002 } from './0002_requirements.js';
import { migration as m0003 } from './0003_rules_proposals_approval_log.js';
import { migration as m0004 } from './0004_settings.js';
import { migration as m0005 } from './0005_runs.js';
import { migration as m0006 } from './0006_sessions_tool_calls.js';
import { migration as m0007 } from './0007_session_budget.js';
import { migration as m0008 } from './0008_judgments.js';
import { migration as m0009 } from './0009_code_open_records.js';
import { migration as m0010 } from './0010_tool_call_empty_name.js';
import { migration as m0011 } from './0011_rule_writer_requests.js';
import { migration as m0012 } from './0012_confirmations.js';
import { migration as m0013 } from './0013_norm_changes.js';
import { migration as m0014 } from './0014_rule_writer_daily_budget_skip.js';
import { migration as m0015 } from './0015_run_queue.js';
import { migration as m0016 } from './0016_run_auto_start.js';
import { migration as m0017 } from './0017_session_norm_input.js';
import { migration as m0018 } from './0018_rule_retirements.js';
import { migration as m0019 } from './0019_confirmation_release.js';
import { migration as m0020 } from './0020_session_objection_end.js';
import { migration as m0021 } from './0021_integrity_gaps.js';
import { migration as m0022 } from './0022_block_declarations.js';
import { migration as m0023 } from './0023_structure_judge_runner.js';
import { migration as m0024 } from './0024_contracts.js';
import { migration as m0025 } from './0025_contract_judge_runner.js';
import { migration as m0026 } from './0026_mutation_results.js';
import { migration as m0027 } from './0027_mutation_reinforcements.js';
import { migration as m0028 } from './0028_review_queue.js';
import { migration as m0029 } from './0029_asyncapi_judge_runner.js';
import { migration as m0030 } from './0030_run_continuations.js';

export const PROJECT_MIGRATIONS: readonly Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
  m0020,
  m0021,
  m0022,
  m0023,
  m0024,
  m0025,
  m0026,
  m0027,
  m0028,
  m0029,
  m0030,
];
