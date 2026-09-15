import { describe, expect, it } from 'vitest';
import { SERVER_EVENT_KINDS } from '@beeline/api-contract/phone';
import {
  beelineCapabilityContextForHarness,
  beelinePrimer,
  BEELINE_REVIEW_SKILL_NAME,
  isConfiguredReviewer,
  usingBeelineSkillMarkdown,
  beelineReviewSkillMarkdown,
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
    // The primer asks for the corner's NAME as well as its objective (C89).
    expect(beelinePrimer()).toContain(
      'call beeline-agent open_corner with a name of at most three words - it titles the corner everywhere - and a complete objective of no more than 24 words',
    );
    expect(markdown).not.toContain('close_corner');
    expect(markdown).not.toContain('no action or corner tools');
  });

  it('tells a model it can subscribe itself, which is the point of the tool', () => {
    // A tool a model never hears about is a tool nobody calls: the welcome
    // agent could not subscribe, and someone edited a database row for it.
    const primer = beelinePrimer();
    expect(primer).toContain('beeline-agent subscribe_events');
    expect(primer).toContain('list_event_subscriptions');
    expect(primer).toContain('joined');
    expect(primer).toContain('You do this yourself');
    expect(primer).toContain('beeline-agent emit_event');
    expect(usingBeelineSkillMarkdown('test-release')).toContain('subscribe_events');
  });

  it('derives the subscribable kinds from SERVER_EVENT_KINDS so the list cannot drift', () => {
    const primer = beelinePrimer();
    for (const kind of SERVER_EVENT_KINDS) {
      expect(primer).toContain(kind);
    }
    expect(primer).toContain(
      'grant-decided carries the grant id and status and resumes the turn that asked for the grant',
    );
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
    expect(context.sessionPrompt).toContain(
      'When open_corner succeeds, the server posts the corner card: do not announce or restate the opening.',
    );
    expect(context.sessionPrompt).toContain('the read-only filesystem sandbox is the boundary');
    expect(context.sessionPrompt).toContain('web search is enabled');
    expect(context.sessionPrompt).toContain(
      'Tag the user only when you need a decision or input, or when the task they asked for is finished.',
    );
    expect(context.compatibilityTurnPrefix).toBe(context.sessionPrompt);
  });
});

describe('using-beeline merge ownership', () => {
  const markdown = usingBeelineSkillMarkdown('test-release');

  it('names merging as the author\'s own step after the reviewer approves', () => {
    // An implementer that never hears this reads the reviewer skill (if it
    // can find one) and refuses to merge on the reviewer's rule.
    expect(markdown).toContain(
      'merging is your step: once the configured reviewer approves and tags you, you run `gh pr merge` yourself - nothing merges it for you.',
    );
  });

  it('carries no never-merge rule for the implementer', () => {
    expect(markdown).not.toContain('Never merge');
  });
});

describe('beeline-review reviewer skill', () => {
  const markdown = beelineReviewSkillMarkdown('test-release');

  it('ends the reviewer\'s authority at approval and leaves the merge to the author', () => {
    expect(markdown).toContain('## 8. Gate and verdict');
    expect(markdown).toContain(
      'Approving is your last step as reviewer. The author merges it; you never do, and nothing merges it automatically.',
    );
  });

  it('carries no bare never-merge sentence the implementer could borrow', () => {
    expect(markdown).not.toContain('Never merge');
  });
});

describe('isConfiguredReviewer', () => {
  it('matches handles with or without their @ prefix and refuses blanks', () => {
    expect(isConfiguredReviewer('fathom', '@fathom')).toBe(true);
    expect(isConfiguredReviewer('@fathom', 'fathom')).toBe(true);
    expect(isConfiguredReviewer('@hoots', '@fathom')).toBe(false);
    expect(isConfiguredReviewer(undefined, '@fathom')).toBe(false);
    expect(isConfiguredReviewer('@hoots', undefined)).toBe(false);
    expect(isConfiguredReviewer('@hoots', '')).toBe(false);
  });
});

describe('using-beeline "Tools and the Workbench" section', () => {
  const markdown = usingBeelineSkillMarkdown('test-release');

  it('gives the agent the tool/key vocabulary and what each known tool is FOR', () => {
    expect(markdown).toContain('## Tools and the Workbench');
    expect(markdown).toContain('A **tool** is something you can use once a human pairs it');
    expect(markdown).toContain('a **key** is the credential that tool holds for that human');
    expect(markdown).toContain('Trusty Squire - vaulted credentials and a browser that signs in');
    expect(markdown).toContain('Wallet and Tailscale');
    expect(markdown).toContain('not yet available');
  });

  it('holds the never-pair / never-ask rule and names the exact path', () => {
    expect(markdown).toContain('You NEVER pair a tool and never ask for a raw credential in chat.');
    expect(markdown).toContain('Settings → Workbench → Tools');
  });

  it('holds the key-sovereignty rule', () => {
    expect(markdown).toContain(
      'they belong to the human who provisioned them. You cannot use another member\'s key and must not ask a member to share one.',
    );
  });
});

describe('using-beeline "Showing a mock" section', () => {
  const markdown = usingBeelineSkillMarkdown('test-release');

  it('carries the Showing a mock section with the post_artifact flow', () => {
    expect(markdown).toContain('## Showing a mock');
    expect(markdown).toContain('beeline-agent post_artifact');
    expect(markdown).toContain('mime "text/html"');
    expect(markdown).toContain('self-contained');
    expect(markdown).toContain('data: URLs');
    expect(markdown).toContain('no script, no external dependencies, no network references');
    expect(markdown).toContain('user stories out as frames');
    expect(markdown).toContain('ask for feedback here in the corner');
  });

  it('pins the Obsidian Refined tokens and the validator refusals', () => {
    expect(markdown).toContain('Obsidian Refined tokens');
    expect(markdown).toContain('#d7af5f');
    expect(markdown).toContain('<script>');
    expect(markdown).toContain('http(s) URL');
  });
});
