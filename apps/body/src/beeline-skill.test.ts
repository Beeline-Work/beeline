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
  beelineSpecSkillMarkdown,
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
    expect(markdown).toContain('beeline-readonly-mcp.search_text');
    expect(markdown).toContain('beeline-readonly-mcp.read_file');
    expect(markdown).toContain('If shell access is blocked');
    expect(markdown).toContain('Use CodeGraph first when it is available');
    expect(beelinePrimer()).toContain('beeline-agent fetch_image');
    expect(beelinePrimer()).toContain('embed as a data: URL');
    // The primer asks for the corner's NAME as well as its objective (C89).
    expect(beelinePrimer()).toContain(
      'call beeline-agent open_corner with a name of at most three words and a navigation objective of no more than 24 words',
    );
    expect(beelinePrimer()).toContain(
      'Before opening a corner, consult beeline-triage and beeline-spec',
    );
    expect(markdown).not.toContain('close_corner');
    expect(markdown).not.toContain('upgrade_corner_to_code');
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

  /**
   * The permission gate approves a shell only inside the OS sandbox, so the
   * session prompt is what keeps the model from asking for one it cannot have
   * and from calling a refusal silence. The fix line rides the same sentence.
   */
  it('states whether this session can run shell commands, and why not when it cannot', () => {
    expect(beelinePrimer(undefined, false, { available: true })).toContain(
      'Shell commands are available in this session',
    );
    const blocked = beelinePrimer(undefined, false, {
      available: false,
      detail: 'bwrap is not on PATH; run `sudo apt-get install -y bubblewrap` and restart.',
    });
    expect(blocked).toContain('Shell commands are NOT available in this session');
    expect(blocked).toContain('Say that plainly in your reply');
    expect(blocked).toContain('sudo apt-get install -y bubblewrap');
    // A DM runs the same harness under the same sandbox, so it carries the fact too.
    expect(beelinePrimer(undefined, true, { available: true })).toContain(
      'Shell commands are available in this session',
    );
    expect(
      beelineCapabilityContextForHarness('codex-acp', undefined, false, { available: true })
        .sessionPrompt,
    ).toContain('Shell commands are available in this session');
  });

  it('no longer claims a scratch file is the only way to write one', () => {
    for (const primer of [beelinePrimer(), beelinePrimer(undefined, true)]) {
      expect(primer).not.toContain('this Room has no other way to write one');
      expect(primer).toContain(
        'To create a file you can send, call beeline-agent write_scratch_file',
      );
    }
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
    expect(context.sessionPrompt).toContain('each resource call checks the original requester');
    expect(context.sessionPrompt).toContain('web search is enabled');
    expect(context.sessionPrompt).toContain(
      'Tag the user only when you need a decision or input, or when the task they asked for is finished.',
    );
    expect(context.compatibilityTurnPrefix).toBe(context.sessionPrompt);
  });

  it('puts every user request on the generic Workbench discovery path in the assembled turn context', () => {
    for (const directMessage of [false, true]) {
      const context = beelineCapabilityContextForHarness('codex-acp', undefined, directMessage);
      expect(context.sessionPrompt).toContain(
        'For every user request, first call beeline-agent workbench_status to check whether a Workbench connector can solve it',
      );
      expect(context.sessionPrompt).toContain(
        'use an applicable connector when it is already added, or call offer_connector when it is available but not added',
      );
      expect(context.sessionPrompt).not.toContain('sign up for an account');
      expect(context.sessionPrompt).not.toContain('API key or other credential');
      expect(context.compatibilityTurnPrefix).toBe(context.sessionPrompt);
    }
  });
});

describe('beeline-triage request skill', () => {
  const markdown = beelineTriageSkillMarkdown('test-release');

  it('clarifies first and warns without blocking on warranted work or desirability', () => {
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).toContain('## 1. Is it clear?');
    expect(markdown).toContain('ask one focused question before opening the corner');
    expect(markdown).toContain('## 2. Is work warranted?');
    expect(markdown).toContain('try to reproduce the exact user-visible behavior');
    expect(markdown).toContain('open or recently merged pull requests');
    expect(markdown).toContain('## 3. Is it desirable?');
    expect(markdown).toContain('repository-owned goals, invariants, architecture');
    expect(markdown).toContain('Warnings inform the user and implementer; they do not block work.');
  });

  it('dispatches under existing authorization and adds only evidence-backed warnings', () => {
    expect(markdown).toContain(
      'pass the complete brief to open_corner under existing authorization',
    );
    expect(markdown).toContain('Triage warning — warranted:');
    expect(markdown).toContain('Triage warning — desirable:');
    expect(markdown).toContain('Do not emit a warning merely because evidence is incomplete');
  });

  it('binds the implementer to a recorded reproduction without blocking triage', () => {
    expect(markdown).toContain(
      'If the need cannot be established, reproduction fails, or other work may obviate it, warn; do not block.',
    );
    expect(markdown).toContain('## Bugfix execution');
    expect(markdown).toContain('They are instruction, not a server gate');
    expect(markdown).toContain('They do not condition the fix on reproduction');
    expect(markdown).toContain('Reproduction <id>: <user path> → <observable wrong result>');
    expect(markdown).toContain('### 1. Attempt to reproduce');
    expect(markdown).toContain('emulator, Playwright, browser, test runner');
    expect(markdown).toContain(
      'If reproduction fails, warn and continue exactly as triage already does',
    );
    expect(markdown).toContain('Never stop');
    expect(markdown).toContain('Never condition the fix on reproduction');
    expect(markdown).not.toContain('Do not fix a bug you have not seen');
    expect(markdown).toContain('### 2. Narrow fix');
    expect(markdown).toContain('Narrow the fix to the reported behavior');
    expect(markdown).toContain('### 3. Proof matching triage');
    expect(markdown).toContain(
      'When none was obtained, state that plainly and show the regression instead',
    );
    expect(markdown).toContain(
      'the reviewer can check that proof, not merely that some test exists',
    );
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

describe('using-beeline human instruction ranking', () => {
  // Soft prompt only: no hold ledger, no refusal check. Independent same-tier
  // holds cannot collapse because this design adds no holder state; the agent
  // reasons from the conversation.
  it('ranks owner then workspace master/admin then member, and forbids field syntax in Room replies', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('## Conflicting human instructions');
    expect(markdown).toMatch(/your own owner first/i);
    expect(markdown).toMatch(/workspace'?s master and admins/i);
    expect(markdown).toMatch(/then members/i);
    expect(markdown).toMatch(/higher-tier instruction overrides a lower-tier hold/i);
    expect(markdown).toContain("A human at the same standing cannot clear another human's hold");
    expect(markdown).toMatch(/only that holder or someone of higher standing can/i);
    expect(markdown).toContain('Never tell a higher-tier human that a lower-tier hold binds them');
    expect(markdown).toMatch(/name the person and their standing in ordinary words/i);
    expect(markdown).toContain('workspaceRole=');
    expect(markdown).toContain('agentOwner');
    expect(markdown).toMatch(/Never write field names or field=value syntax/i);
    expect(beelinePrimer()).not.toContain('## Conflicting human instructions');
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

  it('reviews the diff before lazily creating and always deleting a test checkout', () => {
    expect(markdown.indexOf('Run `gh pr diff N`')).toBeLessThan(
      markdown.indexOf('Check out that exact head only when an empirical command'),
    );
    expect(markdown).toContain('git worktree remove --force');
    expect(markdown).toContain('Cleanup is mandatory on PASS, FAIL, and command error');
    expect(markdown).not.toContain('Check out that exact head in a new scratch git worktree');
  });

  it('fails a bug proof that skips a recorded reproduction identifier', () => {
    expect(markdown).toContain('if a `Reproduction <id>` was recorded, quote it');
    expect(markdown).toContain(
      'FAIL if that proof does not name the identifier, even when other tests pass',
    );
    expect(markdown).toContain(
      'If none was obtained, require the proof to say so plainly and show the regression instead',
    );
    expect(markdown).toContain('reproduction id (or none obtained):');
    expect(markdown).toContain('proof of that reproduction (or none obtained + regression):');
  });

  it('treats verbatim intent and every criterion as product truth', () => {
    expect(markdown).toContain(
      'Quote every verbatim human-intent entry with its source message ID',
    );
    expect(markdown).toContain('short objective is navigation-only text');
    expect(markdown).toContain('List every current criterion ID exactly once');
    expect(markdown).toContain('criterion ledger (every current ID + status + evidence):');
    expect(markdown).toContain('product-completeness findings (block):');
    expect(markdown).toContain('engineering findings (block):');
    expect(markdown).toContain('stable ID that survives rereview');
    expect(markdown).toContain('only through a new human-authorized brief revision');
  });
});

describe('beeline-spec planning skill', () => {
  const markdown = beelineSpecSkillMarkdown('test-release');

  it('keeps the compact path and adds the bounded complex planning loop', () => {
    expect(markdown).toContain('## Compact path for a settled small fix');
    expect(markdown).toContain('## Complex-work planning loop');
    expect(markdown).toContain('### 1. Scope and current state');
    expect(markdown).toContain('### 2. User stories and product boundary');
    expect(markdown).toContain('### 3. Architecture and data flow');
    expect(markdown).toContain('### 4. Failure modes and test map');
    expect(markdown).toContain('### 5. Mocks and references');
    expect(markdown).toContain('### 6. Implementation tasks');
    expect(markdown).toContain('### 7. Bounded adversarial second read (default on)');
    expect(markdown).toContain('Do not recursively review the review');
  });

  it('defines typed authority and proportional durable approval without blanket go', () => {
    for (const field of [
      'intentVerbatim[]',
      'buildSpec',
      'criteria[]',
      'references[]',
      'approvalBasis',
    ])
      expect(markdown).toContain(field);
    expect(markdown).toContain('Do not infer approval from silence');
    expect(markdown).toContain('Dispatch without a proposal/go ceremony');
    expect(markdown).toContain('server records it against the exact revision hash');
    expect(markdown).toContain('added automatically to the brief attachment manifest');
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
    expect(markdown).toContain(
      'YouTube Analytics answers only the channel owner account, not a manager',
    );
    expect(markdown).toContain('Tailscale installs its CLI on the selected helper');
    expect(markdown).toContain('tailscale file cp');
    expect(markdown).toContain("I can/can't reach X on this machine because Y; to fix it, Z.");
  });

  // R5: earlier skill text sent the person to Settings → Workbench → Tools
  // (then told the agent to stop at naming the tool). The offer card replaces both.
  it('teaches WHEN to offer a tool from the Room instead of routing the person to a settings page', () => {
    expect(markdown).toContain('**Offer the tool at the moment you need it.**');
    expect(markdown).toContain('do not send them to a settings page');
    expect(markdown).toContain('Call workbench_status first');
    expect(markdown).toContain(
      'Then call offer_connector with the connectorType and one short reason',
    );
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
    expect(markdown).toContain(
      'You never pair a tool yourself and never ask anyone for a key value',
    );
    // The Workbench page survives as the place to MANAGE, reachable from Settings.
    expect(markdown).toContain('(Settings → Workbench)');
    expect(markdown).toContain('you point there to MANAGE what exists, not to add what you need');
  });

  it('holds the key-sovereignty rule', () => {
    expect(markdown).toContain('the agent owner cannot authorize someone else’s resources.');
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

describe('using-beeline "Showing a photograph" section', () => {
  const markdown = usingBeelineSkillMarkdown('test-release');

  it('teaches fetch_image next to Showing a mock, and keeps the validator closed', () => {
    expect(markdown).toContain('## Showing a photograph');
    expect(markdown.indexOf('## Showing a photograph')).toBeGreaterThan(
      markdown.indexOf('## Showing a mock'),
    );
    expect(markdown).toContain('beeline-agent fetch_image');
    expect(markdown).toContain('data:image/jpeg;base64');
    expect(markdown).toContain('do not draw an SVG stand-in');
    expect(markdown).toContain('The validator still refuses every http(s) image reference');
    expect(markdown).toContain('The artifact is a snapshot');
  });
});
