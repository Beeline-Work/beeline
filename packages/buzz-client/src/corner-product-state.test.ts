import { describe, expect, it } from 'vitest';
import { deriveCornerLifecycle } from './corner-product-state.js';
import type { CornerRemoteState } from './corner-remote-state.js';

const remote = (overrides: Partial<CornerRemoteState> = {}): CornerRemoteState => ({
  version: 1,
  cornerId: 'corner',
  branch: 'fm/change',
  state: 'working',
  checks: 'unknown',
  observedAt: 1,
  ...overrides,
});

describe('GitHub-derived corner lifecycle', () => {
  it('shows a live branch as working', () => {
    expect(deriveCornerLifecycle({ archived: false, remote: remote() })).toMatchObject({
      lifecycle: 'working',
      branch: 'fm/change',
    });
  });

  it('shows an open pull request as in review with GitHub facts intact', () => {
    const pr = {
      number: 12,
      url: 'https://github.com/acme/repo/pull/12',
      title: 'Ship it',
      targetBranch: 'main',
      headSha: 'a'.repeat(40),
    };
    expect(
      deriveCornerLifecycle({
        archived: false,
        remote: remote({ state: 'in-review', checks: 'failing', pr }),
      }),
    ).toEqual({
      lifecycle: 'in-review',
      branch: 'fm/change',
      checks: 'failing',
      pr,
    });
  });

  it('renders GitHub read failure as unknown without inventing completion', () => {
    expect(
      deriveCornerLifecycle({
        archived: false,
        remote: remote({ state: 'unknown', checks: 'unknown', reason: 'github unavailable' }),
      }),
    ).toMatchObject({ lifecycle: 'unknown', reason: 'github unavailable' });
  });

  it('uses branch death or archive as done', () => {
    expect(
      deriveCornerLifecycle({
        archived: false,
        remote: remote({ state: 'gone', outcome: 'landed', checks: 'passing' }),
      }),
    ).toMatchObject({ lifecycle: 'done', outcome: 'landed' });
    expect(deriveCornerLifecycle({ archived: true })).toEqual({
      lifecycle: 'done',
      checks: 'unknown',
    });
  });
});
