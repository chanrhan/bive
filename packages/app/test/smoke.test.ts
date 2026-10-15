import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../src/index.js';

describe('@bive/app 뼈대', () => {
  it('패키지 이름을 내보낸다', () => {
    expect(PACKAGE_NAME).toBe('@bive/app');
  });
});
