import { describe, expect, it } from 'vitest';
import { SERVER_EVENT_KINDS } from '@beeline/api-contract/phone';
import {
  beelineCapabilityContextForHarness,
  beelinePrimer,
  BEELINE_REVIEW_SKILL_NAME,
  beelineTriageSkillMarkdown,
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
    expect(beelinePrimer()).toContain(
      'Before emitting `Proposed corner:` or calling open_corner, consult the release-versioned beeline-triage skill',
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
    expect(primer).toContain('ask_choice');
    expect(primer).toContain('open_poll');
    expect(primer).toContain('A plurality is a fact');
  });

  it('delivers strictly conversational guidance for a direct message', () => {
    const primer = beelinePrimer(undefined, true);
    expect(primer).toContain('private direct-message conversation with one person');
    expect(primer).toContain('no repository binding and no corner can be opened');
    expect(primer).not.toContain('open_corner');
    expect(primer).toContain('ask_choice');
    expect(primer).toContain('open_poll is refused here');
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

describe('beeline-triage request skill', () => {
  const markdown = beelineTriageSkillMarkdown('test-release');

  it('clarifies first and warns without blocking on warranted work or desirability', () => {
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).toContain('## 1. Is it clear?');
    expect(markdown).toContain(
      'ask one focused question instead of proposing or opening the corner',
    );
    expect(markdown).toContain('## 2. Is work warranted?');
    expect(markdown).toContain('try to reproduce the exact user-visible behavior');
    expect(markdown).toContain('open or recently merged pull requests');
    expect(markdown).toContain('## 3. Is it desirable?');
    expect(markdown).toContain('repository-owned goals, invariants, architecture');
    expect(markdown).toContain('Warnings inform the user and implementer; they do not block work.');
  });

  it('uses the existing proposal line and adds only evidence-backed warnings', () => {
    expect(markdown).toContain('Proposed corner: <name> — <objective>');
    expect(markdown).toContain('Triage warning — warranted:');
    expect(markdown).toContain('Triage warning — desirable:');
    expect(markdown).toContain('Do not emit a warning merely because evidence is incomplete');
  });
});

describe('using-beeline merge ownership', () => {
  const markdown = usingBeelineSkillMarkdown('test-release');

  it("names merging as the author's own step after the reviewer approves", () => {
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

  it("ends the reviewer's authority at approval and leaves the merge to the author", () => {
    expect(markdown).toContain('## 8. Gate and verdict');
    expect(markdown).toContain(
      'Approving is your last step as reviewer. The author merges it; you never do, and nothing merges it automatically.',
    );
  });

  it('carries no bare never-merge sentence the implementer could borrow', () => {
    expect(markdown).not.toContain('Never merge');
  });

  it('rechecks warranted work and desirability before testing the implementation', () => {
    expect(markdown).toContain('independently repeat the two judgment legs from request triage');
    expect(markdown).toContain('For a bug, reproduce the reported behavior on the target branch');
    expect(markdown).toContain('FAIL confirmed duplicate or obsolete work');
    expect(markdown).toContain('Require a concrete user benefit, the smallest coherent solution');
    expect(markdown).toContain('work warranted evidence:');
    expect(markdown).toContain('desirability evidence:');
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

  it('gives the agent the tool/key vocabulary and where to learn what each tool is FOR', () => {
    expect(markdown).toContain('## Tools and the Workbench');
    expect(markdown).toContain('A **tool** is something you can use once a human adds it');
    expect(markdown).toContain('a **key** is the credential that tool holds for that human');
    expect(markdown).toContain('beeline-agent workbench_status');
    expect(markdown).toContain('Trusty Squire is vaulted credentials plus a browser');
    expect(markdown).toContain('YouTube Analytics answers only the channel owner account, not a manager');
    expect(markdown).toContain('Tailscale is not available yet');
  });

  // R5: earlier skill text sent the person to Settings → Workbench → Tools
  // (then told the agent to stop at naming the tool). The offer card replaces both.
  it('teaches WHEN to offer a tool from the Room instead of routing the person to a settings page', () => {
    expect(markdown).toContain('**Offer the tool at the moment you need it.**');
    expect(markdown).toContain('do not send them to a settings page');
    expect(markdown).toContain('Call workbench_status first');
    expect(markdown).toContain('Then call offer_connector with the connectorType and one short reason');
    expect(markdown).toContain('Only that person or a Workspace admin can accept it');
    expect(markdown).toContain('Your turn pauses on the card');
    expect(markdown).not.toContain('Settings → Workbench → Tools');
    expect(markdown).not.toContain('tell the person exactly where to go');
    expect(markdown).not.toContain('you never walk them through it');
  });

  it('requires research-first prose before an unfamiliar tool is offered', () => {
    expect(markdown).toContain('**Research before you offer, and say so.**');
    expect(markdown).toContain('Never offer a tool you cannot describe');
    expect(markdown).toContain('say plainly that you are looking it up first');
    expect(markdown).toContain('state what you learned in your reply BEFORE the card appears');
    expect(markdown).toContain('Refusing to act blind is part of being trusted with keys');
  });

  it('keeps the offer a setup affordance, never an authority escalation, and never a raw credential', () => {
    expect(markdown).toContain('An offer is setup, never authority');
    expect(markdown).toContain(
      'does not replace a grant, write permission, target-branch confirmation, or the merge gate',
    );
    expect(markdown).toContain('never needs a raw credential in chat');
    expect(markdown).toContain('You never pair a tool yourself and never ask anyone for a key value');
    // The Workbench page survives as the place to MANAGE, reachable from Settings.
    expect(markdown).toContain('(Settings → Workbench)');
    expect(markdown).toContain('you point there to MANAGE what exists, not to add what you need');
  });

  it('holds the key-sovereignty rule', () => {
    expect(markdown).toContain(
      "they belong to the human who provisioned them. You cannot use another member's key and must not ask a member to share one.",
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
