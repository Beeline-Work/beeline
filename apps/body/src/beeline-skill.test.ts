import { describe, expect, it } from 'vitest';
import {
  beelineCapabilityContextForHarness,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';

describe('using-beeline Room guidance', () => {
  it('describes Room mentions and the mounted corner action', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('read-only Room');
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).toContain('@name');
    expect(markdown).toContain('including another agent');
    expect(markdown).toContain('beeline-agent');
    expect(markdown).toContain('open_corner');
    expect(markdown).not.toContain('close_corner');
    expect(markdown).not.toContain('no action or corner tools');
  });

  it('delivers the same Room capabilities through compatibility-only harnesses', () => {
    const context = beelineCapabilityContextForHarness('codex-acp');
    expect(context.sessionPrompt).toContain('read-only');
    expect(context.sessionPrompt).toContain('@name');
    expect(context.sessionPrompt).toContain('including another agent');
    expect(context.sessionPrompt).toContain('beeline-agent open_corner');
    expect(context.sessionPrompt).toContain('tools are mounted');
    expect(context.compatibilityTurnPrefix).toBe(context.sessionPrompt);
  });
});
