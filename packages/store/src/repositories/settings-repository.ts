// 프로젝트 설정 리포지토리 (COST-01, NFR-07, SCR-21, ADR-057). 입력 · 출력은 `@bive/shared`의 `Settings`로 검증한다.
// - 행이 없으면(한 번도 저장하지 않음) 기본값을 돌려준다. 기본값은 저장하지 않는다
// - 바꾸기는 예산 · 모델 · IDE 패치를 현재 값에 덮어쓴다(없는 키는 그대로, 예산 · 모델의 `null`은 미설정으로)
// - 누가 바꿀 수 있는지(사람만)는 호출한 쪽(오케스트레이터)이 정한다. 여기서는 주체 형식만 검증한다
import {
  defaultSettings,
  HumanAuthor,
  IdeSetting,
  type RoleSettingsMap,
  Settings,
  SettingsPatch,
  Timestamp,
  type Ulid,
} from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { warnOnce } from '../read-warnings.js';

/** 설정 변경의 주체와 시각. `updatedBy` · `updatedAt`이 된다. */
export interface SettingsChange {
  readonly by: HumanAuthor;
  readonly at: Timestamp;
}

interface SettingsRow {
  body: string;
  updated_at: string;
  updated_by: string;
}

/** `body`에 저장하는 필드 (프로젝트 ID · 변경 주체 · 시각 제외). */
type SettingsBody = Omit<Settings, 'projectId' | 'updatedAt' | 'updatedBy'>;

const toBody = (settings: Settings): SettingsBody => ({
  run: settings.run,
  roles: settings.roles,
  approvalQueueLimit: settings.approvalQueueLimit,
  provisionalPolicy: settings.provisionalPolicy,
  autoMode: settings.autoMode,
  installAllowlist: settings.installAllowlist,
  ide: settings.ide,
});

export class SettingsRepository {
  readonly #db: SqliteDatabase;
  readonly #projectId: Ulid;
  readonly #select;
  readonly #upsert;

  constructor(db: SqliteDatabase, projectId: Ulid) {
    this.#db = db;
    this.#projectId = projectId;
    this.#select = db.prepare<[], SettingsRow>(
      'SELECT body, updated_at, updated_by FROM settings WHERE singleton = 1',
    );
    this.#upsert = db.prepare<[SettingsRow]>(
      `INSERT INTO settings (singleton, body, updated_at, updated_by)
       VALUES (1, @body, @updated_at, @updated_by)
       ON CONFLICT (singleton) DO UPDATE SET body = excluded.body,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    );
  }

  /**
   * 현재 설정. 저장한 적이 없으면 기본값(예산 · 모델 미설정, 변경 주체 · 시각 `null`).
   * 저장 뒤 역할이 늘어난 경우(새 역할 키)는 그 역할만 미설정으로 채운다. 잘못된 IDE 선택은 미설정으로 읽는다.
   * @throws {ZodError} 저장된 값이 스키마와 맞지 않을 때
   */
  get(): Settings {
    const defaults = defaultSettings(this.#projectId);
    const row = this.#select.get();
    if (row === undefined) return defaults;
    const body = JSON.parse(row.body) as Record<string, unknown>;
    const storedRoles = (body.roles ?? {}) as Partial<RoleSettingsMap>;
    return Settings.parse({
      ...defaults,
      ...body,
      roles: { ...defaults.roles, ...storedRoles },
      ide: this.#readIde(body.ide),
      projectId: this.#projectId,
      updatedAt: row.updated_at,
      updatedBy: JSON.parse(row.updated_by) as unknown,
    });
  }

  /**
   * 저장된 IDE 선택. 없으면 미설정. 스키마를 어기면(허용 목록이 좁아져 예전에 받던 틀 · 직접 고친 DB) 미설정으로
   * 강등하고 로그 한 줄을 남긴다. 다른 설정은 그대로 읽히고 화면에서 다시 고를 수 있다 (ADR-087). 여는 쪽(main)은
   * 읽은 값을 다시 검증한다. 로그는 같은 프로젝트 · 같은 저장 값이면 프로세스당 한 번(값이 바뀌면 다시 한 번)이고,
   * 저장된 값은 싣지 않는다(프로젝트 ID와 고정 문장만, ADR-094).
   */
  #readIde(value: unknown): IdeSetting | null {
    if (value === undefined || value === null) return null;
    const checked = IdeSetting.safeParse(value);
    if (checked.success) return checked.data;
    warnOnce(
      `settings.ide:${this.#projectId}`,
      JSON.stringify(value),
      `설정의 IDE 선택이 허용 범위가 아니라 미설정으로 읽음 (프로젝트 ${this.#projectId})`,
    );
    return null;
  }

  /**
   * 예산 · 모델 · IDE 패치를 덮어쓰고 변경 주체 · 시각을 기록한다. 바뀐 설정을 돌려준다.
   * @throws {ZodError} 패치 · 주체 · 시각 · 결과가 스키마 위반
   */
  update(patch: SettingsPatch, change: SettingsChange): Settings {
    const { run, roles, ide } = SettingsPatch.parse(patch);
    const by = HumanAuthor.parse(change.by);
    const at = Timestamp.parse(change.at);
    return withTransaction(this.#db, () => {
      const current = this.get();
      const nextRoles = { ...current.roles };
      for (const [role, values] of Object.entries(roles ?? {}) as [
        keyof RoleSettingsMap,
        Partial<RoleSettingsMap[keyof RoleSettingsMap]>,
      ][]) {
        nextRoles[role] = { ...nextRoles[role], ...values };
      }
      const next = Settings.parse({
        ...current,
        run: { ...current.run, ...run },
        roles: nextRoles,
        ide: ide ?? current.ide,
        updatedAt: at,
        updatedBy: by,
      });
      this.#upsert.run({
        body: JSON.stringify(toBody(next)),
        updated_at: at,
        updated_by: JSON.stringify(by),
      });
      return next;
    });
  }
}
