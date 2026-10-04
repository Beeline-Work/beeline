import { describe, expect, it } from 'vitest';
import { PER_ITEM_EVENT_KINDS, SUBSCRIBABLE_EVENT_KINDS } from '@beeline/api-contract/phone';
import {
  BEELINE_REVIEW_SKILL_NAME,
  beelineTriageSkillMarkdown,
  usingBeelineSkillMarkdown,
  beelineReviewSkillMarkdown,
  beelineSpecSkillMarkdown,
} from './beeline-skill.js';
import { assembleSessionPrompt, type SessionPromptContext } from './prompt-assembly.js';

/**
 * The always-on Room rules now live in `prompt-assembly.ts`; the using-beeline
 * skill keeps only the Room mechanics a model looks up on demand.
 */
function sessionPrompt(
  context: Partial<SessionPromptContext> = {},
): ReturnType<typeof assembleSessionPrompt> {
  return assembleSessionPrompt({
    surface: 'room',
    agentName: 'Bee',
    agentCommand: 'claude-agent-acp',
    ...context,
  });
}
const roomPrompt = (context: Partial<SessionPromptContext> = {}) =>
  sessionPrompt(context).systemPrompt;
const dmPrompt = (context: Partial<SessionPromptContext> = {}) =>
  sessionPrompt({ surface: 'dm', ...context }).systemPrompt;

describe('using-beeline Room guidance', () => {
  it('describes Room mentions and the mounted corner action', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('These mechanics apply in Rooms and corners.');
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).toContain('beeline-agent');
    expect(markdown).toContain('beeline-agent fetch_image');
    expect(markdown).toContain('put them in the HTML as a data: URL');
    expect(markdown).not.toContain('close_corner');
    expect(markdown).not.toContain('upgrade_corner_to_code');
    expect(markdown).not.toContain('no action or corner tools');

    // Tagging, the corner action, and read-only inspection are always-on rules.
    const room = roomPrompt();
    expect(room).toContain('Every exact @handle you write wakes that member.');
    expect(room).toContain(
      'Write one only to hand off work, to ask for a decision or input, or, when nothing else announces it, to tell the person who asked that their task is done; otherwise name people and agents in plain prose.',
    );
    expect(room).toContain('If nothing is actionable for you, do not reply.');
    // The Room asks for the corner's NAME as well as its objective (C89).
    expect(room).toContain(
      'call open_corner with a name of at most three words, an objective of at most 24 words, and the brief (a spec plus the approving message)',
    );
    expect(room).toContain('Before opening one, consult beeline-triage and beeline-spec');
    expect(room).toContain('If a shell command is refused, say so plainly');
    expect(room).toContain(
      'read code with CodeGraph when available, then beeline-readonly-mcp search_text and read_file',
    );
    expect(room).toContain('Consult the using-beeline skill for Room mechanics');
  });

  it('tells a model it can subscribe itself, which is the point of the tool', () => {
    // A tool a model never hears about is a tool nobody calls: the welcome
    // agent could not subscribe, and someone edited a database row for it.
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('beeline-agent subscribe_events');
    expect(markdown).toContain('list_event_subscriptions');
    expect(markdown).toContain('joined');
    expect(markdown).toContain('You do this yourself');
    expect(markdown).toContain('beeline-agent emit_event');
  });

  it('tells a model with post-merge work to subscribe to merged, and never to acknowledge a merge', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('A corner merging wakes nobody in its parent Room by default.');
    expect(markdown).toContain('subscribe to merged in the parent Room, from a turn there, before the merge');
    expect(markdown).toContain('act only on the corner you are waiting for, post nothing for any other merge');
    expect(markdown).toContain('take merged back out of your list once nothing is left to wait for');
    expect(markdown).toContain(
      'Never post just to acknowledge a merge: the merge card already announces it.',
    );
  });

  it('derives the subscribable kinds from SUBSCRIBABLE_EVENT_KINDS so the list cannot drift', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    for (const kind of SUBSCRIBABLE_EVENT_KINDS) {
      expect(markdown).toContain(kind);
    }
    // A per-item kind answers one ask and wakes its owner directly; it is
    // never offered as something to subscribe to.
    for (const kind of PER_ITEM_EVENT_KINDS) {
      expect(markdown).not.toContain(`${kind} `);
    }
    expect(markdown).toContain(
      'there is nothing to subscribe to for it, and asking is refused',
    );
    expect(markdown).toContain('ask_choice');
    expect(markdown).toContain('open_poll');
    expect(markdown).toContain('A plurality is a fact');
  });

  it('delivers strictly conversational guidance for a direct message', () => {
    const dm = dmPrompt();
    expect(dm).toContain('private direct message with one person');
    expect(dm).toContain('reply without tagging');
    expect(dm).toContain('no repository work and no corners');
    expect(dm).not.toContain('open_corner');
    expect(dm).toContain('ask_choice');
    expect(dm).not.toContain('open_poll');

    const context = sessionPrompt({ surface: 'dm', agentCommand: 'codex-acp' });
    expect(context.systemPrompt).toContain('private direct message');
    expect(context.systemPrompt).not.toContain('open_corner');
    expect(context.turnPrefix).toBe(context.systemPrompt);
  });

  /**
   * The permission gate approves a shell only inside the OS sandbox, so the
   * session prompt is what keeps the model from asking for one it cannot have
   * and from calling a refusal silence. The fix line rides the same sentence.
   */
  it('states whether this session can run shell commands, and why not when it cannot', () => {
    expect(roomPrompt({ shell: { available: true } })).toContain(
      'Shell commands are available in this session',
    );
    const blocked = roomPrompt({
      shell: {
        available: false,
        detail: 'bwrap is not on PATH; run `sudo apt-get install -y bubblewrap` and restart.',
      },
    });
    expect(blocked).toContain('Shell commands are NOT available in this session');
    expect(blocked).toContain('say that plainly instead of retrying');
    expect(blocked).toContain('sudo apt-get install -y bubblewrap');
    // A DM runs the same harness under the same sandbox, so it carries the fact too.
    expect(dmPrompt({ shell: { available: true } })).toContain(
      'Shell commands are available in this session',
    );
    expect(
      sessionPrompt({ agentCommand: 'codex-acp', shell: { available: true } }).turnPrefix,
    ).toContain('Shell commands are available in this session');
  });

  /**
   * A harness whose shell frames were never measured gets no claim at all
   * (`roomShellCapability` answers `unknown`): telling it either way costs a
   * capability it has or spends every turn retrying a refusal.
   */
  it('claims nothing either way when the harness was not measured', () => {
    for (const prompt of [roomPrompt(), dmPrompt()]) {
      expect(prompt).not.toContain('Shell commands are available in this session');
      expect(prompt).not.toContain('Shell commands are NOT available in this session');
    }
    // The standing conditional guidance still carries that case.
    expect(roomPrompt()).toContain('If a shell command is refused, say so plainly');
  });

  it('states the blocked reason as its own bounded sentence', () => {
    const blocked = roomPrompt({
      shell: {
        available: false,
        detail: 'A shell cannot run here because this host’s OS sandbox failed its self-test.',
      },
    });
    expect(blocked).toContain(
      'say that plainly instead of retrying. Relay this to the person: A shell cannot run here because',
    );
  });

  it('no longer claims a scratch file is the only way to write one', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).not.toContain('this Room has no other way to write one');
    expect(markdown).toContain(
      'To create a file you can send, call beeline-agent write_scratch_file',
    );
  });

  it('names the bound repository and branch when the Room has one', () => {
    expect(roomPrompt({ repository: { name: 'Beeline-Work/beeline', branch: 'main' } })).toContain(
      'The Room is bound to Beeline-Work/beeline (branch main); the read-only checkout is at the session root.',
    );
    const context = sessionPrompt({
      agentCommand: 'codex-acp',
      repository: { name: 'acme/widgets', branch: 'trunk' },
    });
    expect(context.systemPrompt).toContain('bound to acme/widgets (branch trunk)');
    expect(context.turnPrefix).toBe(context.systemPrompt);
  });

  it('delivers the same Room capabilities through compatibility-only harnesses', () => {
    const context = sessionPrompt({ agentCommand: 'codex-acp' });
    expect(context.systemPrompt).toContain('read-only');
    expect(context.systemPrompt).toContain('Every exact @handle you write wakes that member.');
    expect(context.systemPrompt).toContain('call open_corner');
    expect(context.systemPrompt).toContain(
      'When open_corner succeeds the server posts the corner card: do not restate it.',
    );
    expect(context.systemPrompt).toContain("Use your own owner's tools and keys for whoever asks");
    expect(context.systemPrompt).toContain('Web search is available');
    expect(context.systemPrompt).toContain(
      'to ask for a decision or input, or, when nothing else announces it, to tell the person who asked that their task is done',
    );
    expect(context.turnPrefix).toBe(context.systemPrompt);
    // A harness that honors the session prompt gets no duplicate on every turn.
    expect(sessionPrompt().turnPrefix).toBe('');
  });

  it('points a missing tool at Workbench discovery without a forced check on every request', () => {
    for (const surface of ['room', 'dm'] as const) {
      const context = sessionPrompt({ surface, agentCommand: 'codex-acp' });
      expect(context.systemPrompt).toContain(
        'When you need a tool you do not have, call workbench_status; offer_connector the tool it lists, otherwise call connect_app for the app.',
      );
      expect(context.systemPrompt).not.toContain('For every user request');
      expect(context.systemPrompt).not.toContain('sign up for an account');
      expect(context.systemPrompt).not.toContain('API key or other credential');
      expect(context.turnPrefix).toBe(context.systemPrompt);
    }
  });
});

describe('beeline-triage request skill', () => {
  const markdown = beelineTriageSkillMarkdown('test-release');

  it('clarifies first and warns without blocking on warranted work or desirability', () => {
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).toContain('## 1. Is it clear?');
    expect(markdown).toContain('resolve it with the human before doing anything else');
    expect(markdown).toContain('never resolve it by adopting a teammate\'s plan, a prior document, or your own assumption');
    expect(markdown).toContain('you are expected to disagree, not just permitted to');
    expect(markdown).toContain('tag a Room colleague for an adversarial second opinion');
    expect(markdown).toContain('skip this only when you are the only agent in the Room');
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

  it('leaves merging to the corner session prompt, which owns the merge gate', () => {
    expect(markdown).not.toContain('gh pr merge');
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
    expect(markdown).toMatch(/workspace'?s owner and admins/i);
    expect(markdown).toMatch(/then members/i);
    expect(markdown).toMatch(/higher-tier instruction overrides a lower-tier hold/i);
    expect(markdown).toContain("A human at the same standing cannot clear another human's hold");
    expect(markdown).toMatch(/only that holder or someone of higher standing can/i);
    expect(markdown).toContain('Never tell a higher-tier human that a lower-tier hold binds them');
    expect(markdown).toMatch(/name the person and their standing in ordinary words/i);
    expect(markdown).toContain('workspaceRole=');
    expect(markdown).toContain('agentOwner');
    expect(markdown).toMatch(/Never write field names or field=value syntax/i);
    expect(roomPrompt()).not.toContain('## Conflicting human instructions');
  });
});

describe('beeline-review reviewer skill', () => {
  const markdown = beelineReviewSkillMarkdown('test-release');

  it("ends the reviewer's authority at approval and leaves the merge to the server", () => {
    expect(markdown).toContain('## 8. Gate and verdict');
    expect(markdown).toContain(
      'then reply `approved <reviewed sha>` without tagging the author. Do not tell the author to merge.',
    );
    expect(markdown).not.toContain('approved <reviewed sha>, merge');
    expect(markdown).toContain(
      'Approving is your last step as reviewer. The server squash-merges that exact head once checks are green',
    );
    expect(markdown).toContain('Neither you nor the author merges it.');
    expect(markdown).toContain(
      'mergeAllowed true for the current head; the server then merges that head.',
    );
  });

  it('never instructs anyone to run gh pr merge', () => {
    expect(markdown).not.toContain('gh pr merge');
  });

  it('checks UI diffs against DESIGN.md, its lints and every shipped theme', () => {
    expect(markdown).toContain('### Design rules');
    expect(markdown).toContain('the repository has a DESIGN.md');
    expect(markdown).toContain('npx vitest run sources/buzz/calm-lint sources/buzz/design-lint');
    expect(markdown).toContain('FAIL when a design baseline count grows');
    expect(markdown).toContain('in each theme the app ships (in Beeline, Obsidian and Bone)');
    expect(markdown).toContain('A design-rule violation is an engineering finding and blocks PASS.');
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

  it('treats the spec outline as scope and lets the approval quote win', () => {
    expect(markdown).toContain('Quote the approval with its message ID and approver');
    expect(markdown).toContain("The spec's outline (user stories, non-goals, risks) is the scope");
    expect(markdown).toContain('it wins any conflict with the spec');
    expect(markdown).toContain('short objective is navigation-only text');
    expect(markdown).toContain('list every `## User stories` line exactly once');
    expect(markdown).toContain(
      'outline ledger (every user story, non-goal and risk + status + evidence; mock-vs-screen notes for frontend work):',
    );
    expect(markdown).toContain('the affected outline line or `engineering`');
    expect(markdown).not.toMatch(/criteri|AC-\d|revision and hash/);
    expect(markdown).toContain('product-completeness findings (block):');
    expect(markdown).toContain('engineering findings (block):');
    expect(markdown).toContain('stable ID that survives rereview');
    expect(markdown).toContain('only through a new human-authorized brief revision');
  });

  it('sends a brief with no user stories to grade back to the author instead of approving', () => {
    expect(markdown).toContain('no stories to list is a FAIL, sent back to the author to write the outline');
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

  it('defines a spec, files, and one approving message without blanket go', () => {
    for (const part of [
      '`spec`',
      '`## Intent`',
      '`## User stories`',
      '`## Non-goals`',
      '`## Risks`',
      '`## References`',
      '`attachments`',
      '`approval`: one human Room message ID',
    ])
      expect(markdown).toContain(part);
    expect(markdown).not.toMatch(/intentVerbatim|buildSpec|approvalBasis|criteria\[\]/);
    expect(markdown).toContain('Do not infer approval from silence');
    expect(markdown).not.toContain('Dispatch without a proposal/go ceremony');
    expect(markdown).toContain('Always compose the full outline and post it to the Room before calling open_corner');
    expect(markdown).toContain("ask the corner's opener to approve it");
    expect(markdown).toContain('added automatically to the brief attachment manifest');
  });
});

describe('using-beeline "Tools and the Workbench" section', () => {
  const markdown = usingBeelineSkillMarkdown('test-release');

  it('requires live host inspection before answering about current state', () => {
    const tools = markdown.split('## Tools and the Workbench\n')[1]?.split('\n## ')[0];
    expect(tools).toContain('inspect its live state with the tools you have');
    expect(tools).toContain('processes, logs, local endpoints or service status');
    expect(tools).toContain('Say what you checked');
    expect(tools).toContain('Memory and Room history are not evidence of current state');
  });

  it('uses available tools before asking for a value while preserving key and grant authority', () => {
    const tools = markdown.split('## Tools and the Workbench\n')[1]?.split('\n## ')[0];
    expect(tools).toContain('Before asking a person for a code, a status or a file');
    expect(tools).toContain(
      'call workbench_status and check whether a tool or connected app you already have can get it, then use it',
    );
    expect(tools).toContain('an emailed verification code in an already-connected inbox');
    expect(tools).toContain('Ask only when none can, and say why');
    expect(tools).toContain('The key-ownership and grant rules still apply');
    expect(tools).toContain("another person's keys need that person's private scoped approval");
    expect(tools).toContain('does not replace a grant');
  });

  it('gives the agent the tool/key vocabulary and where to learn what each tool is FOR', () => {
    expect(markdown).toContain('## Tools and the Workbench');
    expect(markdown).toContain('A **tool** is something you can use once a human adds it');
    expect(markdown).toContain('a **key** is the credential that tool holds for that human');
    expect(markdown).toContain('beeline-agent workbench_status');
    expect(markdown).toContain('Trusty Squire is vaulted credentials plus a browser');
    expect(markdown).toContain(
      'Fetch a multi-field credential (e.g. email and password) with one fetch_credential call, omitting field',
    );
    expect(markdown).toContain('pass field only to target one specific field');
    expect(markdown).toContain('Connected apps are listed once per app with a stable ID');
    expect(markdown).toContain('Tailscale installs its CLI on the selected helper');
    expect(markdown).toContain('tailscale file cp');
    expect(markdown).toContain(
      "I can't reach X on this machine because Y; to fix it, Z. Give one explanation, then take or offer Z.",
    );
  });

  // R5: earlier skill text sent the person to Settings → Workbench → Tools
  // (then told the agent to stop at naming the tool). The offer card replaces both.
  it('teaches WHEN to offer a tool from the Room instead of routing the person to a settings page', () => {
    expect(markdown).toContain('**Offer the tool at the moment you need it.**');
    expect(markdown).toContain('do not send them to a settings page');
    expect(markdown).toContain('Call workbench_status first');
    expect(markdown).toContain(
      'In a Room or DM, call offer_connector with the connectorType and one short reason',
    );
    expect(markdown).toContain('Connector offers are unavailable in corners');
    expect(markdown).toContain('Your turn pauses on the card');
    expect(markdown).not.toContain('Settings → Workbench → Tools');
    expect(markdown).not.toContain('tell the person exactly where to go');
    expect(markdown).not.toContain('you never walk them through it');
  });

  it('asks for a request-specific connect card promise without embedding a stock promise', () => {
    expect(markdown).toContain('request-specific `continuation`');
    expect(markdown).toContain('Do not include a link, credential, account identifier, or private data');
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
    expect(markdown).toContain(
      "another person's keys need that person's private scoped approval before you use them for anyone else, and your owner cannot authorize them.",
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

  it('teaches the fetch_image recipe once, and the Squire route once', () => {
    expect(markdown.split('fetch_image').length - 1).toBe(1);
    expect(markdown.split('Trusty Squire').length - 1).toBe(1);
  });
});
