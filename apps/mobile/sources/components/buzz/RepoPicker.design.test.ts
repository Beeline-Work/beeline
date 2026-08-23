import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./RepoPicker.tsx', import.meta.url), 'utf8');
const linkageSource = readFileSync(new URL('../../buzz/room-repo-picker.ts', import.meta.url), 'utf8');

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

  it('states the GitHub task before a second, explicit browser-opening action', () => {
    expect(source).toContain('GITHUB_REPOSITORY_SELECTION_INSTRUCTION');
    expect(linkageSource).toContain('Choose the repositories Beeline may access, then return.');
    expect(source).toContain('CONTINUE TO GITHUB →');
    expect(source).toContain('setPendingLinkage(plan)');
  });

  it('scrolls a large account instead of rendering past the fold', () => {
    // The candidate list is a height-bounded, virtualized SectionList — a
    // 100+ repo account must be reachable by scroll, never clipped.
    expect(source).toContain('SectionList');
    expect(source).toContain('maxHeight: listMaxHeight');
    expect(source).toContain('MAX_LIST_HEIGHT_FRACTION');
    expect(source).toContain('nestedScrollEnabled');
    // Taps on rows still land while the search keyboard is open.
    expect(source).toContain('keyboardShouldPersistTaps="handled"');
    // The search field stays pinned above the scrolling list.
    const searchIndex = source.indexOf('Search repositories or paste a GitHub URL');
    const listIndex = source.indexOf(`${'`'}${'${'}testIDPrefix}-list${'`'}`);
    expect(searchIndex).toBeGreaterThan(-1);
    expect(listIndex).toBeGreaterThan(searchIndex);
  });

  it('filters live through the shared pure helper, not an inline predicate', () => {
    expect(source).toContain('filterRepoCandidates(candidates, query, installations)');
    expect(linkageSource).toContain('export function filterRepoCandidates');
    expect(linkageSource).toContain('export function matchesRepoQuery');
  });
});
