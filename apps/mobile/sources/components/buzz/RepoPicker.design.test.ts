import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./RepoPicker.tsx', import.meta.url), 'utf8');

describe('GitHub repository picker launch flow', () => {
  it('keeps search, account grouping, create, and add-installation actions in one picker', () => {
    expect(source).toContain('Search repos or paste github.com/owner/repo');
    expect(source).toContain('installation.accountLogin');
    expect(source).toContain('＋ Create a new repo');
    expect(source).toContain('＋ Add an account or organization');
  });

  it('turns a pasted inaccessible repository into an explicit connection action', () => {
    expect(source).toContain('githubFullNameFromInput(query)');
    expect(source).toContain('Add this repo to the Beeline installation →');
    expect(source).toContain('`Connect ${pastedOwner} →`');
  });
});
