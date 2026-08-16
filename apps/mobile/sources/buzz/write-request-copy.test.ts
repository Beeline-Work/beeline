import { describe, expect, it } from 'vitest';
import { describeWriteRequest } from './write-request-copy';

describe('describeWriteRequest', () => {
  it('replaces raw package commands with the intent people need to approve', () => {
    expect(describeWriteRequest('npm install --ignore-scripts')).toBe(
      'The agent wants to install project dependencies without running setup scripts.',
    );
  });

  it('names an affected file without exposing the underlying tool', () => {
    expect(describeWriteRequest('str_replace README.md')).toBe('The agent wants to update README.md.');
  });
});
