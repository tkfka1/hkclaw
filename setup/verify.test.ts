import { describe, expect, it } from 'vitest';

import { getPrimaryServiceStatus } from './verify.js';

describe('getPrimaryServiceStatus', () => {
  it('returns not_configured when no services are present', () => {
    expect(getPrimaryServiceStatus([])).toBe('not_configured');
  });

  it('returns the first service status when services exist', () => {
    expect(
      getPrimaryServiceStatus([
        {
          name: 'hkclaw-admin',
          status: 'running',
        },
      ]),
    ).toBe('running');
  });
});
