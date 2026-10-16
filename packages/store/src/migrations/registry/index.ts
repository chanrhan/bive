// 등록부 DB(`$BIVE_HOME/registry.db`)의 마이그레이션 목록. 규칙은 `../project/index.ts`와 같다.
import type { Migration } from '../../migrate.js';
import { migration as m0001 } from './0001_registered_projects.js';

export const REGISTRY_MIGRATIONS: readonly Migration[] = [m0001];
