import { describe, expect, it } from 'vitest';
import { PER_ITEM_EVENT_KINDS } from '@beeline/api-contract/phone';
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
    expect(markdown).toContain('These mechanics apply in Rooms, corners and DMs.');
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).toContain('beeline-agent');
    expect(markdown).toContain('beeline-agent scratch_io(action:image)');
    expect(markdown).toContain('put them in the HTML as a data: URL');
    expect(markdown).toContain('close_corner_pr(address)');
    expect(markdown).not.toContain('upgrade_corner_to_code');
    expect(markdown).not.toContain('no action or corner tools');

    // Tagging, the corner action, and read-only inspection are always-on rules.
    const room = roomPrompt();
    expect(room).toContain('Tag to talk. Order to assign work.');
    expect(room).toContain(
      'order(address, agent, text) assigns privately',
    );
    expect(room).toContain('If nothing is actionable for you, do not reply.');
    // The Room asks for the corner's NAME as well as its objective (C89).
    expect(room).toContain(
      'call open_corner with the target room address, a name of at most three words joined by hyphens (no whitespace), an objective of at most 24 words, and the brief (a spec plus the approving message)',
    );
    expect(room).toContain('Before opening one, consult beeline-triage and beeline-spec');
    expect(room).toContain('If a shell command is refused, say so plainly');
    expect(room).toContain(
      'read code with CodeGraph when available, then repository_io(action:search/read)',
    );
    expect(room).toContain('Consult the using-beeline skill for Room mechanics');
  });

  it('routes memory to one store each and states how each store ages out', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    const memory = markdown.slice(markdown.indexOf('## Memory'), markdown.indexOf('## Connect an app'));
    for (const tool of [
      'remember(kind:fact, action:save)',
      'remember(kind:procedure, action:save)',
      'app_tool(app:beeline:workflow, tool:save)',
      'app_tool(app:beeline:workflow, tool:start)',
      'search(scope:history)',
      'remember(kind:fact, action:used)',
      'search(scope:memory, query)',
      'inspect vault metadata',
      'connect(mode:status)',
      'remember(kind:procedure, action:delete)',
    ]) {
      expect(memory, tool).toContain(tool);
    }
    expect(memory).toContain('No background reviewer exists');
    // The workspace-core lookup lives in the turn prompt, which knows the
    // Workspace's own procedure list; a static skill cannot, so this section
    // must not name read(facet:procedure) at all.
    expect(memory).not.toContain('read(facet:procedure)');
    expect(memory).toContain('`workspace-core`');
    expect(memory).toContain('Never save "X is impossible".');
    expect(memory).toContain('at most 2,200 characters');
    // The upkeep and search-first rules stay in their tool descriptions.
    expect(memory).not.toContain('Before saving, call search(scope:memory, query)');
    expect(memory).not.toContain('Meaning-based matching');
    expect(markdown.match(/X is impossible/g)).toHaveLength(1);
  });

  it('teaches self-only wake management and event discovery', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('wake manages only your own wake sources');
    expect(markdown).toContain('events discovers the catalog');
    expect(markdown).toContain('replace_events replaces your own room-kind subscription list');
    expect(markdown).toContain('wake never posts, orders or reports');
    for (const kind of PER_ITEM_EVENT_KINDS) expect(markdown).not.toContain(`${kind} `);
    expect(markdown).toContain('no item-specific subscriptions');
  });

  it('watches corner lifecycle with committed wakes rather than reminder loops', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('lifecycle watches a reachable corner for opened/merged');
    expect(markdown).toContain('Chatter and schedules never wake watchers');
    expect(markdown).toContain('use no_reply_needed when mounted; otherwise end silently');
    expect(markdown).toContain('No reminder loops');
  });

  it('lets a direct message drive member Rooms through the command grammar', () => {
    const dm = dmPrompt();
    expect(dm).toContain('private direct message with one person');
    expect(dm).toContain('reply without tagging');
    expect(dm).toContain('across member Rooms');
    expect(dm).toContain('open_corner');
    expect(dm).toContain('Ask plain questions');
    expect(dm).not.toContain('open_poll');

    const context = sessionPrompt({ surface: 'dm', agentCommand: 'codex-acp' });
    expect(context.systemPrompt).toContain('private direct message');
    expect(context.systemPrompt).toContain('open_corner');
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
      'Create files with native tools; where unavailable, use scratch_io',
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
    expect(context.systemPrompt).toContain('Tag to talk. Order to assign work.');
    expect(context.systemPrompt).toContain('call open_corner');
    expect(context.systemPrompt).toContain(
      'When open_corner succeeds the server posts the corner card: do not restate it.',
    );
    expect(context.systemPrompt).toContain("Use your own owner's tools and keys for whoever asks");
    expect(context.systemPrompt).toContain('Web search is available');
    expect(context.systemPrompt).toContain(
      'report(status, text) one step up to your commander',
    );
    expect(context.turnPrefix).toBe(context.systemPrompt);
    // A harness that honors the session prompt gets no duplicate on every turn.
    expect(sessionPrompt().turnPrefix).toBe('');
  });

  it('points a missing tool at Connectors discovery without a forced check on every request', () => {
    for (const surface of ['room', 'dm'] as const) {
      const context = sessionPrompt({ surface, agentCommand: 'codex-acp' });
      expect(context.systemPrompt).toContain(
        'For any service or capability request, use connect(mode:discover) if unclear, then connect(mode:ensure, service, reason, continuation).',
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

  it('leaves clarification to judgment and warns without blocking on warranted work or desirability', () => {
    expect(markdown).toContain('beeline-release: test-release');
    expect(markdown).toContain('## 1. Is it clear?');
    expect(markdown).toContain('Report needs-decision: to your commander for material unresolved intent');
    expect(markdown).toContain('When a person asks for a spec or mock, produce it before building');
    expect(markdown).not.toContain('before doing anything else');
    expect(markdown).toContain('you are expected to disagree, not just permitted to');
    expect(markdown).toContain('reachable child or sibling corner for one adversarial second opinion');
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
      'pass the complete brief to open_corner with the dispatching message as approval',
    );
    expect(markdown).toContain('no separate outline post or human approval is required');
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

describe('using-beeline human instructions and holds', () => {
  // Soft prompt only: no hold ledger, no refusal check. Independent same-tier
  // holds cannot collapse because this design adds no holder state; the agent
  // reasons from the conversation.
  it('accepts any human instruction while preserving hold provenance and plain Room replies', () => {
    const markdown = usingBeelineSkillMarkdown('test-release');
    expect(markdown).toContain('## Conflicting human instructions');
    // The rule itself is always-on prompt text; the skill keeps the hold mechanics.
    expect(markdown).not.toContain('Any human in the Room can direct you.');
    expect(roomPrompt()).toContain('Any human in the Room can direct you. Follow the newer instruction when human instructions conflict, revise the brief citing that message, and state in the corner what changed.');
    expect(markdown).not.toContain('Follow the order from your commander within inherited scope');
    expect(markdown).toContain('report one step up');
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
  it('leads with the verdict, one blocker and a concrete worker next step', () => {
    expect(markdown).toContain('Lead with the verdict and the one blocking reason');
    expect(markdown).toContain('List only blocking items');
    expect(markdown).toContain('FAIL: a removed Room member can still read its transcript');
    expect(markdown).toContain('Next: fix the membership guard and repeat the authenticated read proof');
    expect(markdown).toContain('No full outline ledger, message IDs, commit hashes');
    expect(markdown).not.toContain('decision: PASS|FAIL');
  });
  it('checks complete scope privately, with commander-authorized revisions', () => {
    expect(markdown).toContain('Check every story and criterion');
    expect(markdown).toContain('confirm non-goals stayed out');
    expect(markdown).toContain('each risk');
    // The corner author contract in the reviewer's own prompt carries the human-direction rule.
    expect(markdown).not.toContain('Any human in the Room can direct you.');
    expect(markdown).not.toContain('Your chain of command');
    expect(markdown).not.toContain('A higher rank');
    expect(markdown).not.toContain('Instructions from outside your chain');
    expect(markdown).not.toContain('ask your commander for an authorized revision');
  });
  it('obtains proof autonomously and reports missing capability to the commander', () => {
    expect(markdown).toContain('Obtain available proof in the review Workspace');
    expect(markdown).toContain('Agents have no signed-in Beeline browser session or review secret');
    expect(markdown).toContain('the worker reports blocked: to its commander once');
    expect(markdown).toContain('Do not keep failing review on that unavailable proof');
    expect(markdown).toContain('Inner-function tests, code inspection and logs do not prove a visual claim');
  });
  it('reviews one exact green head and permits landing through the live gate', () => {
    expect(markdown).toContain('headRefOid');
    expect(markdown).toContain('Review only that exact head; if it moves, start again');
    expect(markdown).toContain('checks="passed" and checkCount=0');
    expect(markdown).toContain('An empty CI rollup alone proves nothing');
    expect(markdown).toContain('approve_merge');
    expect(markdown).toContain('merge_corner');
    expect(markdown).not.toMatch(/never merge|do not merge|only human approval/i);
  });
  it('uses an isolated checkout, preserves worker work and reviews design and security', () => {
    expect(markdown).toContain('never the worker');
    expect(markdown).toContain('git worktree remove --force');
    expect(markdown).toContain('on PASS, FAIL or error');
    expect(markdown).toContain('review:exact-head');
    expect(markdown).toContain('calm-lint sources/buzz/design-lint');
    expect(markdown).toContain('Obsidian and Bone');
    expect(markdown).toContain('resource authority, credentials and migration safety');
    expect(markdown).toContain('scope creep');
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
      '`## Acceptance criteria`',
      '`## Non-goals`',
      '`## Risks`',
      '`## References`',
      '`attachments`',
      '`approval`: the initiating human message ID or private commander order ID',
    ])
      expect(markdown).toContain(part);
    expect(markdown).not.toMatch(/intentVerbatim|buildSpec|approvalBasis|criteria\[\]/);
    expect(markdown).toContain(
      "the requester's own rules from `## Intent`, quoted verbatim and numbered, each naming the test",
    );
    expect(markdown).toContain('Do not infer approval from silence');
    expect(markdown).not.toContain('Dispatch without a proposal/go ceremony');
    expect(markdown).toContain('Keep the outline in the brief; no separate post or approval is required.');
    expect(markdown).toContain('The dispatching message authorizes the work');
    expect(markdown).toContain('when a person asks for a spec or mock, produce it before building');
    expect(markdown).not.toContain("ask the corner's opener to approve it");
    expect(markdown).toContain('added automatically to the brief attachment manifest');
  });
});

describe('using-beeline "Tools and the Connectors" section', () => {
  const markdown = usingBeelineSkillMarkdown('test-release');

  it('requires live host inspection before answering about current state', () => {
    const tools = markdown.split('## Tools and the Connectors\n')[1]?.split('\n## ')[0];
    expect(tools).toContain('inspect its live state with the tools you have');
    expect(tools).toContain('processes, logs, local endpoints or service status');
    expect(tools).toContain('Say what you checked');
    expect(tools).toContain('Memory and Room history are not evidence of current state');
  });

  it('uses available tools before asking for a value while preserving key and grant authority', () => {
    const tools = markdown.split('## Tools and the Connectors\n')[1]?.split('\n## ')[0];
    expect(tools).toContain('Before asking a person for a code, a status or a file');
    expect(tools).toContain(
      'call connect(mode:status) and check whether a tool or connected app you already have can get it, then use it',
    );
    expect(tools).toContain('an emailed verification code in an already-connected inbox');
    expect(tools).toContain('Report blocked: to your commander only when none can, and say why');
    expect(tools).toContain('The key-ownership and grant rules still apply');
    expect(tools).toContain("another person's keys need that person's private scoped approval");
    expect(tools).toContain('does not replace a grant');
  });

  it('gives the agent the tool/key vocabulary and where to learn what each tool is FOR', () => {
    expect(markdown).toContain('## Tools and the Connectors');
    expect(markdown).toContain('A **tool** is something you can use once a human adds it');
    expect(markdown).toContain('a **key** is the credential that tool holds for that human');
    expect(markdown).toContain('beeline-agent connect(mode:status)');
    expect(markdown).toContain('Trusty Squire signs up and signs in to any website hands-off');
    expect(markdown).toContain(
      'Use operate_drive for a browser goal.',
    );
    expect(markdown).toContain('Connected apps are listed once per app with a stable ID');
    expect(markdown).toContain('Tailscale installs its CLI on the selected helper');
    expect(markdown).toContain('tailscale file cp');
    expect(markdown).toContain(
      "I can't reach X on this machine because Y; to fix it, Z. Give one explanation, then take or offer Z.",
    );
  });

  it('teaches one server-owned connection path in every surface', () => {
    // The always-on prompt carries the rule; the skill keeps the route mechanics.
    expect(markdown).not.toContain('For any service or capability request');
    expect(markdown).toContain('drive the supplied goal locally and recheck connect');
    expect(markdown).toContain('switchGoogleAccount');
    expect(markdown).toContain('end the turn and wait for its connection wake');
    expect(markdown).not.toContain('call offer_connector');
  });

  it('asks for a request-specific connect card promise without embedding a stock promise', () => {
    expect(markdown).toContain('request-specific `continuation`');
    expect(markdown).toContain('Do not include a link, credential, account identifier, or private data');
  });

  it('keeps service search silent and setup on the server', () => {
    expect(markdown).toContain('Search shows the user nothing');
    expect(markdown).toContain('the server chooses the route; follow its actual readiness or needs_squire response');
    expect(markdown).toContain('Do not provision or pair a route yourself');
  });

  it('keeps the offer a setup affordance, never an authority escalation, and never a raw credential', () => {
    expect(markdown).toContain('Connecting is setup, never authority');
    expect(markdown).toContain(
      'does not replace a grant, write permission, target-branch confirmation, or the merge gate',
    );
    expect(markdown).toContain('never needs a raw credential in chat');
    expect(markdown).toContain(
      'You never pair a tool yourself and never ask anyone for a key value',
    );
    // The Workbench page survives as the place to MANAGE, reachable from Settings.
    expect(markdown).toContain('(Settings → Connectors)');
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
    expect(markdown).toContain('mime:"text/html"');
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

  it('teaches scratch_io(action:image) next to Showing a mock, and keeps the validator closed', () => {
    expect(markdown).toContain('## Showing a photograph');
    expect(markdown.indexOf('## Showing a photograph')).toBeGreaterThan(
      markdown.indexOf('## Showing a mock'),
    );
    expect(markdown).toContain('beeline-agent scratch_io(action:image)');
    expect(markdown).toContain('data:image/jpeg;base64');
    expect(markdown).toContain('do not draw an SVG stand-in');
    expect(markdown).toContain('The validator still refuses every http(s) image reference');
    expect(markdown).toContain('The artifact is a snapshot');
  });

  it('teaches the scratch_io(action:image) recipe once, and the Squire route once', () => {
    expect(markdown.split('scratch_io(action:image)').length - 1).toBe(1);
    const photograph = markdown.split('## Showing a photograph\n')[1]?.split('\n## ')[0];
    expect(photograph).not.toContain('Trusty Squire');
  });
});

it('keeps the command contract aligned with asynchronous ordering and corner-only watches', () => {
  const text = usingBeelineSkillMarkdown('test-release');
  // The always-on prompt carries the end-the-turn rule; the skill does not restate it.
  expect(text).not.toContain('After ordering another agent, end the turn');
  expect(roomPrompt()).toContain('After ordering another agent, end the turn; its report wakes a new turn; do not sleep or poll.');
  expect(text).not.toContain('read(address) and watch(address) across member Rooms, corners and DMs');
});
