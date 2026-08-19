import { describe, expect, it } from 'vitest';
import {
  canonicalizeGitRemote,
  parseGitRemoteInput,
  repositoryKeyForRemote,
  repositoryNameFromCanonicalRemote,
} from './git-url.js';

describe('canonicalizeGitRemote', () => {
  it('strips credentials and .git suffix from an https URL', () => {
    expect(canonicalizeGitRemote('https://token@example.com/Acme/widget.git')).toBe(
      'git://example.com/Acme/widget',
    );
  });

  it('normalizes an scp-style ssh URL to the same canonical form as the https equivalent', () => {
    expect(canonicalizeGitRemote('git@example.com:Acme/widget.git')).toBe(
      'git://example.com/Acme/widget',
    );
  });

  it('lowercases the host but preserves path case', () => {
    expect(canonicalizeGitRemote('https://GitHub.com/Acme/Widget')).toBe(
      'git://github.com/Acme/Widget',
    );
  });

  it('trims a trailing slash', () => {
    expect(canonicalizeGitRemote('https://example.com/Acme/widget/')).toBe(
      'git://example.com/Acme/widget',
    );
  });

  it('throws on empty input', () => {
    expect(() => canonicalizeGitRemote('  ')).toThrow();
  });
});

describe('repositoryKeyForRemote', () => {
  it('is deterministic for the same canonical remote', () => {
    const a = repositoryKeyForRemote('git://example.com/Acme/widget');
    const b = repositoryKeyForRemote('git://example.com/Acme/widget');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different remotes', () => {
    expect(repositoryKeyForRemote('git://example.com/Acme/widget')).not.toBe(
      repositoryKeyForRemote('git://example.com/Acme/other'),
    );
  });

  it('converges the https and ssh forms of the same repo to the same key', () => {
    const httpsKey = repositoryKeyForRemote(
      canonicalizeGitRemote('https://token@example.com/Acme/widget.git'),
    );
    const sshKey = repositoryKeyForRemote(canonicalizeGitRemote('git@example.com:Acme/widget.git'));
    expect(httpsKey).toBe(sshKey);
  });
});

describe('repositoryNameFromCanonicalRemote', () => {
  it('uses the last path segment', () => {
    expect(repositoryNameFromCanonicalRemote('git://example.com/Acme/widget', 'fallback')).toBe(
      'widget',
    );
  });

  it('falls back when the path is empty', () => {
    expect(repositoryNameFromCanonicalRemote('git://example.com/', 'fallback')).toBe('fallback');
  });
});

describe('parseGitRemoteInput', () => {
  it('returns a valid RoomRepositoryInput for a pasted https URL', () => {
    const input = parseGitRemoteInput('https://github.com/Acme/widget.git');
    expect(input).toEqual({
      key: repositoryKeyForRemote('git://github.com/Acme/widget'),
      name: 'widget',
      remote: 'git://github.com/Acme/widget',
    });
  });

  it('returns null for empty input', () => {
    expect(parseGitRemoteInput('   ')).toBeNull();
  });
});
