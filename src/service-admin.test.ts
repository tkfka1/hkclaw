import { describe, expect, it } from 'vitest';

import { buildSuggestedGroupFolder } from './service-admin.js';

describe('buildSuggestedGroupFolder', () => {
  it('builds a service-prefixed folder name', () => {
    expect(buildSuggestedGroupFolder('Launch Bay', 'codex', [])).toBe(
      'codex-launch-bay',
    );
  });

  it('avoids collisions by appending a numeric suffix', () => {
    expect(
      buildSuggestedGroupFolder('Launch Bay', 'codex', ['codex-launch-bay']),
    ).toBe('codex-launch-bay-2');
  });
});
