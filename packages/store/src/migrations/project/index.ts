// 프로젝트별 DB(`$BIVE_HOME/projects/<projectId>/bive.db`)의 마이그레이션 목록.
// 새 마이그레이션은 이 폴더에 `<NNNN>_<name>.ts`(다음 번호, 4자리)로 추가하고 아래 배열 끝에 넣는다.
// 머지된 파일은 고치지 않는다 (적용 기록의 SQL 해시와 달라지면 DB를 열지 않는다).
import type { Migration } from '../../migrate.js';
import { migration as m0001 } from './0001_projects.js';
import { migration as m0002 } from './0002_requirements.js';
import { migration as m0003 } from './0003_rules_proposals_approval_log.js';
import { migration as m0004 } from './0004_settings.js';

export const PROJECT_MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003, m0004];
