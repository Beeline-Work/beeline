import { describe, expect, it } from 'vitest';
import {
  beelineCapabilityContextForHarness,
  beelinePrimer,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';

describe('using-beeline Room guidance', () => {
  it('describes Room mentions and the mounted corner action', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('filesystem is read-only');
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).toContain('@name');
    expect(markdown).toContain('including another agent');
    expect(markdown).toContain(
      'Tag another agent only when you need something from them: a question, a handoff, a task. Never tag to acknowledge, agree, or say you are ready. If nothing is actionable, do not reply.',
    );
    expect(markdown).toContain(
      'Tag the user only when you need a decision or input, or when the task they asked for is finished. Never tag for progress, acknowledgement, or questions the transcript already answers.',
    );
    expect(markdown).toContain('beeline-agent');
    expect(markdown).toContain('open_corner');
    expect(markdown).not.toContain('close_corner');
    expect(markdown).not.toContain('no action or corner tools');
  });

  it('delivers strictly conversational guidance for a direct message', () => {
    const primer = beelinePrimer(undefined, true);
    expect(primer).toContain('private direct-message conversation with one person');
    expect(primer).toContain('no repository binding and no corner can be opened');
    expect(primer).not.toContain('open_corner');
    expect(primer).not.toContain('@name');

    const context = beelineCapabilityContextForHarness('codex-acp', undefined, true);
    expect(context.sessionPrompt).toContain('direct-message conversation');
    expect(context.sessionPrompt).not.toContain('open_corner');
  });

  it('names the bound repository and branch when the Room has one', () => {
    const primer = beelinePrimer({ name: 'Beeline-Work/beeline', branch: 'main' });
    expect(primer).toContain(
      'This Room is bound to Beeline-Work/beeline (branch main); you have a read-only checkout at the session root.',
    );
    const context = beelineCapabilityContextForHarness('codex-acp', {
      name: 'acme/widgets',
      branch: 'trunk',
    });
    expect(context.sessionPrompt).toContain('bound to acme/widgets (branch trunk)');
    expect(context.compatibilityTurnPrefix).toBe(context.sessionPrompt);
  });

  it('delivers the same Room capabilities through compatibility-only harnesses', () => {
    const context = beelineCapabilityContextForHarness('codex-acp');
    expect(context.sessionPrompt).toContain('read-only');
    expect(context.sessionPrompt).toContain('@name');
    expect(context.sessionPrompt).toContain('including another agent');
    expect(context.sessionPrompt).toContain('beeline-agent open_corner');
    expect(context.sessionPrompt).toContain('the read-only filesystem sandbox is the boundary');
    expect(context.sessionPrompt).toContain('web search is enabled');
    expect(context.sessionPrompt).toContain(
      'Tag the user only when you need a decision or input, or when the task they asked for is finished.',
    );
    expect(context.compatibilityTurnPrefix).toBe(context.sessionPrompt);
  });
});
