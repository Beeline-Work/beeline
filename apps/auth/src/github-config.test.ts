import { describe, expect, it } from 'vitest';
import { GITHUB_CONFIG_KEYS, githubEnvironmentConfig } from './github-config.js';

describe('GitHub launch configuration gate', () => {
  const complete = Object.fromEntries(GITHUB_CONFIG_KEYS.map((key) => [key, `${key}-value`]));

  it('enables GitHub only when every required value is present', () => {
    expect(githubEnvironmentConfig(complete)).toEqual(complete);
  });

  it.each(GITHUB_CONFIG_KEYS)('stays dark when %s is absent', (missing) => {
    const partial = { ...complete };
    delete partial[missing];
    expect(githubEnvironmentConfig(partial)).toBeUndefined();
  });
});
