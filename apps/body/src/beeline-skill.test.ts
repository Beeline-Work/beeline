import { describe, expect, it } from 'vitest';
import { usingBeelineSkillMarkdown } from './beeline-skill.js';

describe('using-beeline Room guidance', () => {
  it('describes the thin read-only Room contract without action tools', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('read-only Room');
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).not.toContain('open_corner');
    expect(markdown).not.toContain('close_corner');
  });
});
