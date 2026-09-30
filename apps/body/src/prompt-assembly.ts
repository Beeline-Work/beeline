import type { CornerBrief, DaemonOperationMap } from '@beeline/api-contract/daemon';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';
import { boundRoomTaskBody, budgetTranscript } from './transcript-budget.js';

/**
 * The ONE place Beeline prompt text is written and assembled.
 *
 * Every rule an agent is given lives in a section below: an id, the single
 * topic it owns, why it exists, a byte budget, the surfaces it applies to, and
 * a render function. `assembleSessionPrompt` and `assembleTurnPrompt` are the
 * only builders; the turn loops pass facts in and send what comes out.
 *
 * Guards (`prompt-assembly.test.ts`): each topic has one owner per surface, no
 * sentence repeats inside an assembled prompt, every section stays inside its
 * budget, harnesses that drop the session prompt still receive every session
 * rule, and the assembled prompt for every surface is snapshotted in
 * `docs/prompts/` so a wording change shows up as a readable diff.
 *
 * Where new text goes: a rule for every agent on every turn is a core section;
 * a rule for one surface is a surface section; how to call one tool is that
 * tool's description; a long procedure is a skill; one person's preference is
 * a memory item or their standing preference. Adding a section means cutting
 * or shortening another to stay inside `CORE_BUDGET_BYTES` and the surface
 * budgets.
 */

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];

export const PROMPT_SURFACES = [
  'room',
  'dm',
  'code-corner',
  'review-corner',
  'research-corner',
  'no-code-corner',
] as const;
export type PromptSurface = (typeof PROMPT_SURFACES)[number];

const CORNERS: readonly PromptSurface[] = [
  'code-corner',
  'review-corner',
  'research-corner',
  'no-code-corner',
];
const EVERYWHERE: readonly PromptSurface[] = PROMPT_SURFACES;

/**
 * Ceiling for the rules every agent gets on every turn, soul text excluded
 * (≈575 tokens). The first ~350-token target was a guess; ten rules measure
 * ~2.3 KB (core.feedback raised it from 2.2 KB), so a new core rule has to
 * replace or shorten one.
 */
export const CORE_BUDGET_BYTES = 2_300;
/** Ceiling for one surface's own rules, on top of the core. A code corner uses ~3.9 KB. */
export const SURFACE_BUDGET_BYTES = 4_000;

/**
 * Whether this session can run shell commands, and why not when it cannot.
 * `roomShellCapability` (`harness-capabilities.ts`) settles it from the harness
 * and the sandbox together. An unmeasured harness passes no state at all.
 * `detail` is the ONE bounded operator sentence from
 * `BwrapAvailability.shellDetail`.
 */
export type RoomShellState =
  { readonly available: true } | { readonly available: false; readonly detail?: string };

export interface SessionPromptContext {
  readonly surface: PromptSurface;
  readonly agentName: string;
  readonly soul?: { readonly name: string; readonly instructions: string };
  /** The ACP command; decides whether session text must also ride every turn. */
  readonly agentCommand?: string;
  /** A Room's bound repository and branch (read-only checkout). */
  readonly repository?: { readonly name: string; readonly branch: string };
  readonly shell?: RoomShellState;
  /** A repository corner's feature and target branches. */
  readonly worktree?: { readonly featureBranch: string; readonly targetBranch: string };
  readonly reviewerHandle?: string;
  readonly selfReviewer?: boolean;
  readonly yoloMode?: boolean;
  /** A no-code corner's requester, tagged once in its reply. */
  readonly requesterHandle?: string;
  readonly agentMayUpgradeCorner?: boolean;
}

export interface PromptSection<C> {
  readonly id: string;
  /** The one topic this section owns; two sections on one surface never share it. */
  readonly topic: string;
  /** What breaks without it. A section with no answer here is cut. */
  readonly why: string;
  readonly budgetBytes: number;
  readonly layer: 'core' | 'surface' | 'turn';
  readonly surfaces: readonly PromptSurface[];
  readonly when?: (context: C) => boolean;
  readonly render: (context: C) => string;
}

export interface SectionReport {
  readonly id: string;
  readonly bytes: number;
}

// ---------------------------------------------------------------------------
// Rule text shared with other callers. Each constant is rendered by exactly one
// section below; the exports exist for the nudge and reviewer paths that reuse
// the same words and for tests.
// ---------------------------------------------------------------------------

export const CORNER_AUTHOR_CONTRACT = `The current assigned brief's verbatim human intent and numbered acceptance criteria are the product authority. The short objective is navigation-only text and cannot add, remove, or narrow a requirement.
Implement every current acceptance criterion and use the brief's file manifest. Record relevant validation stages with record_validation_stage against the current revision and head, citing actual commands or observed behavior. Do not call a missing stage passed.
When a human correction changes the assignment, read the latest revision and use revise_corner_brief with the complete updated brief and a change description before doing dependent work. A chat reply does not revise the assignment.
Before any code, write its end-user story in one sentence: "a person who does X sees Y".
Follow the beeline-triage skill's bugfix execution contract when the verbatim human intent reports a defect.
Attempt to reproduce it as triage isolated it, using every tool the host offers: emulator, Playwright, browser, test runner. Record what was tried and what was observed. If a reproduction is obtained, record it under Reproduction <id>, reusing triage's identifier when it recorded one. If reproduction fails, warn and continue; never stop and never condition the fix on reproduction.
Narrow the fix to the authorized intent and current criteria. When a reproduction exists, change only what removes it while satisfying those criteria.
Before opening the pull request, produce Y against the built change: run the app or affected service from your branch and perform X.
If no interactive surface is reachable, run the narrowest test or script that exercises the exact user path and prints the observable Y.
A unit test of an inner function, a log line, or reading the code is not a demonstration.
The pull request body MUST contain two sections with exactly these headings: ## Reproduced and ## Demonstrated.
Under ## Reproduced, name Reproduction <id> and give the steps or command and what was observed; write "not obtained" when reproduction failed, or "not a defect report" for feature work.
Under ## Demonstrated, cite the same identifier and show that reproduction now passing when one exists; when none was obtained, state that plainly and show the regression instead.
A pull request without both sections is not deliverable and the Room's reviewer will fail it.
Change only what the verbatim intent and current criteria authorize. No unrequested features, flags, compatibility shims, or refactors.`;

export const CORNER_REVIEWER_SESSION_INSTRUCTION =
  "You are this Room's configured reviewer. The active turn prompt names the latest stable green PR head. Review and approve only that exact head; if no stable green head is named, end the turn without a verdict. Never merge yourself.";

export const CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION =
  'There is no stable green PR head for this active reviewer turn. Do not review or call approve_merge. End this turn without a verdict; the next green transition will wake you.';

export const CORNER_DELIVERY_NUDGE =
  'Before ending this turn, inspect the repository state and finish delivering the work unless a human hold stands: commit and push the intended changes and open the pull request if one does not exist. Decide yourself whether any remaining dirty work belongs to the objective; do not discard it merely to make the worktree clean. The pull request body must carry ## Reproduced and ## Demonstrated; if they are missing, add them before ending the turn.';

export const CORNER_YOLO_MERGE_NUDGE =
  'Yolo is on. Call pr_checks_status now and merge this pull request with gh pr merge --squash --match-head-commit <sha> only when it returns checks="passed" and mergeAllowed=true. If checks="unknown", reply in this corner with the tool reason and stop instead of retrying. Otherwise stop without merging.';

export const RESEARCH_CORNER_HOLD =
  'This is a research corner with writable repository access. Investigate and edit files as needed. Do not commit, push, or open a pull request until a human explicitly directs that step. Never merge. Leave the corner open; only a human closes it.';

/** Shared verbatim between the upgrade_corner_to_code tool description
 *  (`read-only-mcp.ts`) and this corner's own no-code prompt clause below, so
 *  the two surfaces can never say something different. The agent decides when
 *  the work needs repository changes; nobody has to ask for the upgrade. The
 *  server still requires the turn to answer a human message in this corner,
 *  because that message is the approval the upgraded corner's brief quotes. */
export const UPGRADE_INTENT_RULE =
  "Call this on your own judgment when the work in this corner needs repository changes; nobody has to ask for the upgrade. Call it while answering a human message in this corner, because that message becomes the code corner's brief.";

/** Shared verbatim into the search_memory tool description (`read-only-mcp.ts`)
 *  so it is the one place this rule is stated. Meaning-based matching finds a
 *  fact even when the current request shares no words with how it was saved
 *  (see `institutional-memory-embeddings.ts`), so the turn snapshot's keyword
 *  miss is never sufficient grounds to tell someone a fact was never stored. */
export const SEARCH_MEMORY_FIRST_RULE =
  'Call this before telling anyone a fact was never saved, or asking them for information they may already have given you. Meaning-based matching often finds it even when this turn shares no words with how it was originally phrased.';

const handle = (value: string): string => value.replace(/^@/, '');

/**
 * The one merge rule for an author session: what to do once the pull request
 * exists, and who merges it. It owns the `merge` topic, so no other section
 * may speak about merging on the same surface.
 */
export function cornerMergeInstruction(yoloMode: boolean, reviewerHandle?: string): string {
  if (!reviewerHandle)
    return 'Once the pull request exists, reply with its full URL and end the turn; do not check or wait for CI. This Room has no configured reviewer, so the merge gate never opens for you: never merge; a person merges it.';
  const reviewer = `the reviewer (${handle(reviewerHandle)})`;
  return yoloMode
    ? `Once the pull request exists, reply with its full URL and end the turn; do not tag ${reviewer}, check, or wait for CI. Green checks wake ${reviewer}, and the end of that review wakes you, whether or not it tags you. Then call pr_checks_status and merge with gh pr merge --squash --match-head-commit <sha> only when it returns checks="passed" and mergeAllowed=true; otherwise end the turn without merging.`
    : `Once the pull request exists, reply with its full URL and end the turn; do not tag ${reviewer}, check, or wait for CI. Yolo is off, so the merge gate stays closed for you: never merge; a person merges it after ${reviewer} approves.`;
}

export function cornerReviewerInstruction(input: {
  reviewerHandle?: string;
  agentHandle?: string;
  authorHandle?: string;
  openedByAgent: boolean;
  pullRequestNumber?: number;
  headSha?: string;
  briefRevision?: number;
}): string | undefined {
  if (
    !input.reviewerHandle ||
    !input.agentHandle ||
    input.openedByAgent ||
    handle(input.agentHandle) !== handle(input.reviewerHandle)
  )
    return undefined;
  const author = input.authorHandle ? handle(input.authorHandle) : 'author';
  const number = input.pullRequestNumber ?? 'N';
  const headSha = input.headSha ?? '<head sha>';
  return `Checks are green on PR #${number} at ${headSha}${input.briefRevision ? ` with assigned brief revision ${input.briefRevision}` : ''}. Review it now with the beeline-review skill against that exact head and current assigned brief. FAIL: reply \`@${author}\` with the confirmed findings to fix. PASS: call the approve_merge tool for ${headSha}${input.briefRevision ? ` with briefRevision=${input.briefRevision}` : ''}, then reply \`@${author} approved ${headSha}, merge\`. Never merge yourself. Never say you are holding or waiting for checks.`;
}

/**
 * A Room's sole configured reviewer who also opens its own corner has no
 * other reviewer to wait on: `cornerReviewerInstruction` never fires for an
 * opener, so without this the ordinary author instructions would tell this
 * agent to wait for `@<its own handle>` to tag it, a permanent deadlock.
 */
export function cornerSelfReviewerInstruction(input: {
  reviewerHandle?: string;
  agentHandle?: string;
  openedByAgent: boolean;
}): string | undefined {
  if (
    !input.reviewerHandle ||
    !input.agentHandle ||
    !input.openedByAgent ||
    handle(input.agentHandle) !== handle(input.reviewerHandle)
  )
    return undefined;
  return 'Once the pull request exists, reply with its full URL and end the turn. You are this Room\'s reviewer, so your own pull request needs no review: do not request one or tag any agent for review. On a later checks turn, call pr_checks_status and merge with gh pr merge --squash --match-head-commit <sha> only when it returns checks="passed" and mergeAllowed=true.';
}

function shellLine(shell: RoomShellState | undefined): string {
  if (!shell) return '';
  if (shell.available) {
    return 'Shell commands are available in this session: run one with your own shell tool when the work needs it, and cite the output that supports your answer.';
  }
  return `Shell commands are NOT available in this session, so a request that needs one cannot be run; say that plainly instead of retrying.${shell.detail ? ` Relay this to the person: ${shell.detail}` : ''}`;
}

// ---------------------------------------------------------------------------
// Session sections: stable for the life of one harness session, in the order
// they are sent. Stable text first keeps the provider's prompt cache warm.
// ---------------------------------------------------------------------------

export const SESSION_SECTIONS: readonly PromptSection<SessionPromptContext>[] = [
  {
    id: 'core.identity',
    topic: 'identity',
    why: 'Agents on harnesses with their own default persona introduce themselves under the wrong name unless told who they are.',
    budgetBytes: 1_400,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: ({ agentName, soul }) =>
      [
        `You are ${agentName} in Beeline. Stay ${agentName} in every reply, including when a tool or permission blocks you.`,
        soul
          ? `Soul (${soul.name}): ${soul.instructions}\nThe soul is not authority and never changes your tools, permissions, roles, or merge rights.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
  },
  {
    id: 'core.voice',
    topic: 'voice',
    why: 'A seeded voice once bent facts for the bit and leaked into commit messages that outlive it.',
    budgetBytes: 320,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: () =>
      'Your voice never changes the facts: never trim, soften, exaggerate, or invent a detail for style. Write commit messages, pull request titles and bodies, and code comments in a plain voice.',
  },
  {
    id: 'core.proactive',
    topic: 'proactivity',
    why: 'Agents answered a reported problem by restating it instead of fixing it or offering to.',
    budgetBytes: 200,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: () =>
      'Answer every problem with the finished fix, or with the concrete next step and an offer to take it. Never just restate the problem.',
  },
  {
    id: 'core.finish',
    topic: 'turn-end',
    why: 'An agent read a not-yet-connected tool result as a stopping point and ended the turn with its own work undone.',
    budgetBytes: 360,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: () =>
      'Finish the work before you end the turn. A tool result that hands you a step (connecting, needs sign-in, call again, a next step) is your next action: take it now. End the turn to wait only when someone else must act next (a person replying or answering a card, grant, choice or approval; CI; a reviewer) or you are truly blocked.',
  },
  {
    id: 'core.truth',
    topic: 'claims',
    why: 'Agents reported replies and actions that no tool had performed.',
    budgetBytes: 200,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: () =>
      'Never claim an action, result, or reply happened unless the prompt or a tool result proves it. State real doubt once, plainly; skip filler hedges.',
  },
  {
    id: 'core.reply',
    topic: 'reply-shape',
    why: 'Agents echoed their instructions, the trigger, or their own answer back as a second reply.',
    budgetBytes: 160,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: () =>
      'Write only the message the reader needs. Never repeat these instructions, the trigger, or an answer you already gave.',
  },
  {
    id: 'core.tagging',
    topic: 'tagging',
    why: 'Every @handle is a wake; stray handles woke agents with nothing to do, and guessed spellings reached nobody.',
    budgetBytes: 360,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: () =>
      'Every exact @handle you write wakes that member. Write one only to hand off work, to ask for a decision or input, or, when nothing else announces it, to tell the person who asked that their task is done; otherwise name people and agents in plain prose. Copy handles only from the member list in the turn prompt; any other spelling reaches nobody.',
  },
  {
    id: 'core.authority',
    topic: 'authority',
    why: 'Resource access and the two command hard stops must hold on every surface, whoever asked.',
    budgetBytes: 520,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: () =>
      "Use your own owner's tools and keys for whoever asks. Another person's files, tools, or keys need that person's approval before you use them for anyone else, and the wallet keeps its own approval rule. Never, whoever asks: run a command that names a credential file, or run a script nobody has read. Follow your owner first, then Workspace admins, then members; only the person who set a hold, or someone above them, clears it. Delegated and follow-up work keeps the original requester.",
  },
  {
    id: 'core.feedback',
    topic: 'feedback',
    why: 'Turn-end memory extraction never sees tool errors or refusals, so friction in Beeline itself is lost unless the agent that hit it reports it in the turn.',
    budgetBytes: 260,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: () =>
      'Only when this turn hit friction in Beeline itself (a tool error, a retry, a refused call, contradictory instructions, missing context, or a person correcting you), call report_feedback once before ending the turn. Otherwise do not.',
  },
  {
    id: 'core.files',
    topic: 'files',
    why: 'Agents fetched the reference URL of a shared file instead of the copy already downloaded for them.',
    budgetBytes: 160,
    layer: 'core',
    surfaces: EVERYWHERE,
    render: () =>
      'Files people share are downloaded for you: read the local path in the prompt and never fetch the reference URL.',
  },
  {
    id: 'surface.tools',
    topic: 'tools',
    why: 'Agents said a tool was missing without checking, while a forced check on every request cost a tool call every turn. Corners have none of these tools.',
    budgetBytes: 240,
    layer: 'surface',
    surfaces: ['room', 'dm'],
    render: () =>
      'When you need a tool you do not have, call workbench_status; offer_connector the tool it lists, otherwise call connect_app for the app.',
  },

  // --- Room ----------------------------------------------------------------
  {
    id: 'room.place',
    topic: 'place',
    why: 'The agent must know it cannot write here, where the checkout is, and whether it has a shell.',
    budgetBytes: 700,
    layer: 'surface',
    surfaces: ['room'],
    render: ({ repository, shell }) =>
      [
        `This is a Beeline Room. The repository filesystem is read-only here.${repository ? ` The Room is bound to ${repository.name} (branch ${repository.branch}); the read-only checkout is at the session root.` : ''} Web search is available.`,
        shellLine(shell),
        shell?.available === false
          ? 'Read code with CodeGraph when available, then beeline-readonly-mcp search_text and read_file.'
          : 'If a shell command is refused, say so plainly rather than retrying, and read code with CodeGraph when available, then beeline-readonly-mcp search_text and read_file.',
      ]
        .filter(Boolean)
        .join(' '),
  },
  {
    id: 'room.corners',
    topic: 'repository-work',
    why: 'Repository work must start through the host-governed corner, with a brief as its authority.',
    budgetBytes: 900,
    layer: 'surface',
    surfaces: ['room'],
    render: () =>
      [
        'Repository changes happen only in a corner. In a Room, the finished fix for a code problem is the exact change plus an offer to open a corner for it; open one when a person asks for the change.',
        'Before opening one, consult beeline-triage and beeline-spec, then call open_corner with a name of at most three words, an objective of at most 24 words, and the typed brief. The objective only titles the work; the brief is its authority. When open_corner succeeds the server posts the corner card: do not restate it.',
        'For corners you belong to, use inspect_corner for status, steer_corner to pass Room input down, and ask_corner for one answer. Never post into a corner without a Room command.',
      ].join(' '),
  },
  {
    id: 'room.replying',
    topic: 'room-replies',
    why: 'Several agents share a Room; replies with nothing to act on, and echoed nudges, are noise.',
    budgetBytes: 520,
    layer: 'surface',
    surfaces: ['room'],
    render: () =>
      'If nothing is actionable for you, do not reply. If the current task is only a nudge to respond, answer the most recent unanswered human message instead of echoing the nudge. A poll plurality is a fact, never permission to deploy, delete, merge, or spend. Consult the using-beeline skill for Room mechanics (files, artifacts, schedules, reactions, events, mocks).',
  },

  // --- DM ------------------------------------------------------------------
  {
    id: 'dm.place',
    topic: 'place',
    why: 'A DM has one person, no repository work, and no corners; the agent must not tag or try to open one.',
    budgetBytes: 700,
    layer: 'surface',
    surfaces: ['dm'],
    render: ({ shell }) =>
      [
        'This is a private direct message with one person: everything they send is for you, so reply without tagging. It has no repository work and no corners, and the filesystem is read-only. Web search is available.',
        shellLine(shell),
      ]
        .filter(Boolean)
        .join(' '),
  },
  {
    id: 'dm.choices',
    topic: 'choices',
    why: 'A pick in a DM is a preference, never authority, and polls need an electorate.',
    budgetBytes: 300,
    layer: 'surface',
    surfaces: ['dm'],
    render: () =>
      'ask_choice offers options; a pick is a preference, never sandbox, spend, or merge authority. Consult the using-beeline skill for files, artifacts, and reactions.',
  },

  // --- Corners -------------------------------------------------------------
  {
    id: 'corner.worktree',
    topic: 'place',
    why: 'The agent must know its branch and target; only a code-corner author is told to push and open the pull request.',
    budgetBytes: 520,
    layer: 'surface',
    surfaces: ['code-corner', 'review-corner', 'research-corner'],
    render: ({ worktree, surface }) =>
      [
        `You are in an isolated git worktree on ${worktree?.featureBranch ?? 'the feature branch'}, targeting ${worktree?.targetBranch ?? 'the target branch'}.`,
        surface !== 'code-corner'
          ? ''
          : `Commit and push only ${worktree?.featureBranch}; never force-push or write to ${worktree?.targetBranch}. Before pushing, rebase on origin/${worktree?.featureBranch}; resolve conflicts autonomously, realigning to that remote branch and redoing the work if needed, then rerun affected tests. Open the pull request with gh.`,
      ]
        .filter(Boolean)
        .join('\n'),
  },
  {
    id: 'corner.research',
    topic: 'merge',
    why: 'Research corners explore; nothing leaves the worktree until a human says so.',
    budgetBytes: 320,
    layer: 'surface',
    surfaces: ['research-corner'],
    render: () => RESEARCH_CORNER_HOLD,
  },
  {
    id: 'corner.contract',
    topic: 'author-contract',
    why: 'The reviewer enforces this contract; an author that never saw it fails review.',
    budgetBytes: 2_600,
    layer: 'surface',
    surfaces: ['code-corner'],
    render: () => CORNER_AUTHOR_CONTRACT,
  },
  {
    id: 'corner.merge',
    topic: 'merge',
    why: 'Exactly one rule may say who merges and when; two rules here once said both "merge" and "never merge".',
    budgetBytes: 520,
    layer: 'surface',
    surfaces: ['code-corner'],
    render: ({ yoloMode, reviewerHandle, selfReviewer }) =>
      (selfReviewer
        ? cornerSelfReviewerInstruction({
            reviewerHandle,
            agentHandle: reviewerHandle,
            openedByAgent: true,
          })!
        : cornerMergeInstruction(Boolean(yoloMode), reviewerHandle)) +
      ' Never merge any other pull request.',
  },
  {
    id: 'corner.checks',
    topic: 'checks-turns',
    why: 'Server check notes were restated as replies, and agents scheduled polls of a gate that wakes them itself.',
    budgetBytes: 900,
    layer: 'surface',
    surfaces: ['code-corner'],
    render: () =>
      'A checks turn is one that wakes you about CI or the merge gate. On it, say nothing unless you merge, push a fix, or report checks="unknown", and then use one short line. Never restate server check or merge notes. When asked whether the reviewer was woken, call pr_checks_status and report reviewerWake; do not invent a cause. Never schedule polls of pr_checks_status or the merge gate; the server wakes you when it changes. If a schedule wakes you here anyway, treat it as a checks turn.',
  },
  {
    id: 'corner.review',
    topic: 'merge',
    why: 'The reviewer approves one exact green head and never merges.',
    budgetBytes: 400,
    layer: 'surface',
    surfaces: ['review-corner'],
    render: () =>
      `${CORNER_REVIEWER_SESSION_INSTRUCTION} Report findings to the author; never edit or push the author's branch.`,
  },
  {
    id: 'corner.no-code',
    topic: 'place',
    why: 'A no-code corner has no repository; the agent delivers files, not commits.',
    budgetBytes: 1_000,
    layer: 'surface',
    surfaces: ['no-code-corner'],
    render: ({ agentMayUpgradeCorner }) =>
      [
        "This is a no-code corner with no repository checkout and no GitHub workflow. Work in this corner's writable workspace: create files with write_scratch_file or your own tools, then send them with post_artifact.",
        agentMayUpgradeCorner
          ? `Do not initialize a repository, create a branch, commit, push, open a pull request, or wait for GitHub checks. The one exception is beeline-agent upgrade_corner_to_code. ${UPGRADE_INTENT_RULE} That one-way upgrade restarts this same corner with a feature branch and writable checkout, keeps its discussion, and re-delivers that same request in the code session, so end this turn immediately once it succeeds and do not edit this workspace.`
          : 'Do not initialize a repository, create a branch, commit, push, open a pull request, or wait for GitHub checks.',
      ].join('\n'),
  },
  {
    id: 'corner.no-code-reply',
    topic: 'reply-target',
    why: 'Every turn was told to end with a one-line summary of files it posted, so answers were followed by a restatement of themselves.',
    budgetBytes: 260,
    layer: 'surface',
    surfaces: ['no-code-corner'],
    render: ({ requesterHandle }) =>
      `${requesterHandle ? `Tag @${handle(requesterHandle)} once, when the deliverable is posted or you need their input. ` : ''}When you posted files, name them in one line; never restate your answer. Only a human closes this corner.`,
  },
];

export interface AssembledSessionPrompt {
  /** Sent as the ACP session system prompt. */
  readonly systemPrompt: string;
  /**
   * The same text again for a harness that drops the session prompt
   * (`harnessHonorsSessionSystemPrompt`): it rides at the top of every turn,
   * so a Codex, Pi, or Grok session gets the corner rules too. Empty otherwise.
   */
  readonly turnPrefix: string;
  readonly report: readonly SectionReport[];
}

function applicable<C extends { surface: PromptSurface }>(
  sections: readonly PromptSection<C>[],
  context: C,
): Array<{ section: PromptSection<C>; text: string }> {
  return sections
    .filter(
      (section) => section.surfaces.includes(context.surface) && (section.when?.(context) ?? true),
    )
    .map((section) => ({ section, text: section.render(context).trim() }))
    .filter((entry) => entry.text);
}

export function sessionSections(
  context: SessionPromptContext,
): Array<{ section: PromptSection<SessionPromptContext>; text: string }> {
  return applicable(SESSION_SECTIONS, context);
}

export function assembleSessionPrompt(context: SessionPromptContext): AssembledSessionPrompt {
  const entries = sessionSections(context);
  const systemPrompt = entries.map((entry) => entry.text).join('\n\n');
  return {
    systemPrompt,
    turnPrefix: harnessHonorsSessionSystemPrompt(context.agentCommand) ? '' : systemPrompt,
    report: entries.map(({ section, text }) => ({
      id: section.id,
      bytes: Buffer.byteLength(text),
    })),
  };
}

// ---------------------------------------------------------------------------
// Turn sections: rebuilt every prompt attempt. Only facts change here.
// ---------------------------------------------------------------------------

export function renderAssignedCornerBrief(brief: CornerBrief): string {
  if (brief.legacy || !Array.isArray(brief.intentVerbatim) || !Array.isArray(brief.criteria)) {
    return `Legacy assigned corner brief ${brief.id} revision ${brief.revision}:\n${brief.content}`;
  }
  const intent = brief.intentVerbatim
    .map((item) => `- [message ${item.sourceMessageId}] ${item.snapshot}`)
    .join('\n');
  const criteria = brief.criteria.map((item) => `- ${item.id}: ${item.text}`).join('\n');
  const nonGoals = brief.nonGoals?.map((item) => `- ${item}`).join('\n') || '(none)';
  const references =
    brief.references
      ?.map(
        (item) =>
          `- ${item.label} [${item.authority}]${item.objectId ? ` object ${item.objectId}` : ''}: ${item.description}`,
      )
      .join('\n') || '(none)';
  const basis = brief.approvalBasis;
  const approval =
    basis.kind === 'legacy-pre-migration'
      ? basis.reason
      : `${basis.kind} by ${basis.approvedBy}, message ${basis.sourceMessageId}: ${basis.snapshot}`;
  return `Assigned corner brief ${brief.id} revision ${brief.revision} (hash ${brief.revisionHash}; current server revision):

Verbatim human intent — authoritative:
${intent}

Current acceptance criteria — authoritative:
${criteria}

Non-goals:
${nonGoals}

References and authority:
${references}

Approval basis bound to this revision:
${approval}

Build spec — implementation guidance:
${brief.buildSpec}`;
}

/**
 * The member list: the only place handle spellings come from. The rule for
 * using them is `core.tagging`; this renders the facts only.
 */
export function roomMentionDirectory(roster: WorkspaceRoster, selfId: string): string {
  const rows: string[] = [];
  for (const member of roster.members) {
    if (member.identityId === selfId) continue;
    const memberHandle = member.handle?.trim().replace(/^@/, '');
    if (!memberHandle) continue;
    const name = member.name?.trim() ?? '';
    const kind = member.kind === 'agent' ? 'agent' : 'person';
    rows.push(`- @${memberHandle}${name && name !== memberHandle ? ` — ${name}` : ''} (${kind})`);
  }
  if (!rows.length) return '';
  return ['Members (exact tag spellings):', ...rows].join('\n');
}

export interface TurnPromptContext {
  readonly surface: PromptSurface;
  /** Actual selected model window when known; conservative default otherwise. */
  readonly modelContextTokens?: number;
  /** `AssembledSessionPrompt.turnPrefix`. */
  readonly sessionPrefix?: string;
  readonly standingPreference?: { readonly requesterName: string; readonly text: string };
  readonly objective?: string;
  readonly brief?: {
    readonly brief: CornerBrief;
    readonly fileLines: readonly string[];
    readonly missingRequiredFile: boolean;
  };
  readonly checkout?: { readonly branch: string; readonly commit: string };
  /** Rendered rows and whether earlier rows were withheld as already seen. */
  readonly transcript?: { readonly lines: readonly string[]; readonly sinceLastTurn: boolean };
  readonly resume?: string;
  readonly members?: string;
  readonly memory?: string;
  readonly corners?: readonly unknown[];
  readonly closedCorners?: readonly {
    readonly name?: string;
    readonly cornerId: string;
    readonly pullRequestNumber?: number;
    readonly mergeCommitSha?: string;
  }[];
  readonly reviewerTarget?: string;
  readonly task: {
    /** Room: who the server selected this task from. */
    readonly fromName?: string;
    readonly cornerAskId?: string;
    readonly reactionTargetId?: string;
    readonly body: string;
    readonly attachmentLines?: readonly string[];
  };
}

const ROOMS: readonly PromptSurface[] = ['room', 'dm'];

export const TURN_SECTIONS: readonly PromptSection<TurnPromptContext>[] = [
  {
    id: 'turn.session',
    topic: 'session-delivery',
    why: 'Codex, Pi, and Grok drop the ACP session prompt; without this they never saw the corner rules.',
    budgetBytes: 16_000,
    layer: 'turn',
    surfaces: EVERYWHERE,
    render: ({ sessionPrefix }) => sessionPrefix ?? '',
  },
  {
    id: 'turn.standing',
    topic: 'standing-preference',
    why: 'A person’s every-turn preferences are stored once and must reach whichever agent answers them.',
    budgetBytes: 480,
    layer: 'turn',
    surfaces: EVERYWHERE,
    render: ({ standingPreference }) =>
      standingPreference
        ? `For ${standingPreference.requesterName} (overrides your default style; the rules above still win): ${standingPreference.text}`
        : '',
  },
  {
    id: 'turn.objective',
    topic: 'objective',
    why: 'The objective locates the work but must never be mistaken for its authority.',
    budgetBytes: 600,
    layer: 'turn',
    surfaces: CORNERS,
    render: ({ objective }) =>
      objective ? `Corner objective (navigation only, not product authority): ${objective}` : '',
  },
  {
    id: 'turn.brief',
    topic: 'brief',
    why: 'The brief is the product authority for corner work; a corner without one says so once.',
    budgetBytes: 24_000,
    layer: 'turn',
    surfaces: CORNERS,
    render: ({ brief }) =>
      brief
        ? `${renderAssignedCornerBrief(brief.brief)}\n\nAssigned files:\n${brief.fileLines.join('\n') || '(none)'}${brief.missingRequiredFile ? '\nRequired assignment files are unavailable. Pause work that depends on them and report the missing file precisely.' : ''}`
        : 'No assigned brief: the human messages in this corner are the authority; skip steps that need a brief revision.',
  },
  {
    id: 'turn.checkout',
    topic: 'checkout',
    why: 'A Room checkout is refreshed per turn; the agent must know which commit it reads.',
    budgetBytes: 200,
    layer: 'turn',
    surfaces: ROOMS,
    render: ({ checkout }) =>
      checkout
        ? `Repository checkout: origin/${checkout.branch} at commit ${checkout.commit}, refreshed for this turn.`
        : '',
  },
  {
    id: 'turn.transcript',
    topic: 'transcript',
    why: 'The conversation so far, with rows this session already saw left out.',
    budgetBytes: 200_000,
    layer: 'turn',
    surfaces: EVERYWHERE,
    render: ({ transcript, surface }) => {
      if (!transcript?.lines.length) return '';
      const place = ROOMS.includes(surface) ? 'Room' : 'corner';
      return `${transcript.sinceLastTurn ? `New in the ${place} since your last turn:` : `${place === 'Room' ? 'Room conversation' : 'Corner transcript'}:`}\n${transcript.lines.join('\n')}`;
    },
  },
  {
    id: 'turn.resume',
    topic: 'resume',
    why: 'A card answer resumes a paused turn; the agent must know which question was answered.',
    budgetBytes: 600,
    layer: 'turn',
    surfaces: ROOMS,
    render: ({ resume }) => resume ?? '',
  },
  {
    id: 'turn.members',
    topic: 'members',
    why: 'Handle spellings change; only the live roster is a safe source.',
    budgetBytes: 4_000,
    layer: 'turn',
    surfaces: EVERYWHERE,
    render: ({ members }) => members ?? '',
  },
  {
    id: 'turn.memory',
    topic: 'memory',
    why: 'Keyword-matched institutional memory, compiled and capped by the server.',
    budgetBytes: 1_000,
    layer: 'turn',
    surfaces: EVERYWHERE,
    render: ({ memory }) => memory ?? '',
  },
  {
    id: 'turn.corners',
    topic: 'corners',
    why: 'Room agents need exact corner ids to inspect, steer, or ask their corners.',
    budgetBytes: 8_000,
    layer: 'turn',
    surfaces: ['room'],
    render: ({ corners, closedCorners }) =>
      [
        corners?.length
          ? `Current corners you belong to (use the exact cornerId with inspect_corner, steer_corner, or ask_corner):\n${JSON.stringify(corners)}`
          : '',
        closedCorners?.length
          ? `Corners you belong to closed in the last 24 hours (merge commit is unavailable when absent):\n${closedCorners
              .map(
                (corner) =>
                  `- ${corner.name ?? corner.cornerId} (${corner.cornerId}): PR ${corner.pullRequestNumber ? `#${corner.pullRequestNumber}` : 'unavailable'}, merge commit ${corner.mergeCommitSha ?? 'unavailable'}`,
              )
              .join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
  },
  {
    id: 'turn.reviewer-target',
    topic: 'reviewer-target',
    why: 'The reviewer must review the head that is green now, not one named in an older message.',
    budgetBytes: 1_200,
    layer: 'turn',
    surfaces: ['review-corner'],
    render: ({ reviewerTarget }) => reviewerTarget ?? '',
  },
  {
    id: 'turn.task',
    topic: 'task',
    why: 'The message this turn answers, said once and last.',
    budgetBytes: 64_000,
    layer: 'turn',
    surfaces: EVERYWHERE,
    render: ({ task, surface }) =>
      ROOMS.includes(surface)
        ? [
            `Current task from ${task.fromName ?? 'a Room member'}:`,
            task.cornerAskId
              ? `Corner ask id: ${task.cornerAskId}. Use get_corner_ask to retrieve its status and answer.`
              : '',
            task.body,
          ]
            .filter(Boolean)
            .join('\n\n')
        : [
            ...(task.reactionTargetId
              ? [`Reaction target message id: ${task.reactionTargetId}`]
              : []),
            `Newest message:\n${task.body}`,
            ...(task.attachmentLines ?? []),
          ].join('\n'),
  },
];

export function assembleTurnPrompt(context: TurnPromptContext): {
  readonly text: string;
  readonly report: readonly SectionReport[];
} {
  const boundedContext = ROOMS.includes(context.surface)
    ? {
        ...context,
        task: {
          ...context.task,
          body: boundRoomTaskBody(context.task.body, context.modelContextTokens),
        },
      }
    : context;
  const withoutTranscript = applicable(TURN_SECTIONS, {
    ...boundedContext,
    transcript: undefined,
  });
  const otherBytes = withoutTranscript.reduce(
    (sum, entry) => sum + Buffer.byteLength(entry.text) + 2,
    0,
  );
  const lines = budgetTranscript(
    boundedContext.transcript?.lines ?? [],
    boundedContext.modelContextTokens,
    otherBytes,
  );
  const entries = applicable(TURN_SECTIONS, {
    ...boundedContext,
    transcript: boundedContext.transcript ? { ...boundedContext.transcript, lines } : undefined,
  });
  return {
    text: entries.map((entry) => entry.text).join('\n\n'),
    report: entries.map(({ section, text }) => ({
      id: section.id,
      bytes: Buffer.byteLength(text),
    })),
  };
}
