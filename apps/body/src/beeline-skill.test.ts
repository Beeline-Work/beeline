import { describe, expect, it } from 'vitest';
import {
  beelineCapabilityContextForHarness,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';

describe('using-beeline Room guidance', () => {
  it('describes the thin read-only Room contract without action tools', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('read-only Room');
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).not.toContain('open_corner');
    expect(markdown).not.toContain('close_corner');
  });

  it('delivers the same thin capability primer through compatibility-only harnesses', () => {
    const context = beelineCapabilityContextForHarness('codex-acp');
    expect(context.sessionPrompt).toContain('read-only');
    expect(context.sessionPrompt).not.toContain('open_corner');
    expect(context.compatibilityTurnPrefix).toBe(context.sessionPrompt);
  });
});
