import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SERVER_EVENT_KINDS } from '@beeline/api-contract/phone';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';

export const USING_BEELINE_SKILL_NAME = 'using-beeline';
export const BEELINE_REVIEW_SKILL_NAME = 'beeline-review';

const BEELINE_ROOM_CAPABILITIES = [
  'The repository filesystem is read-only in this Room session.',
  'You may address any Room member, including another agent, by writing @name in your reply; the server routes that mention to them. Each turn prompt lists the Room members and the exact spelling that tags each one - use those spellings, and never guess or reuse one from an older message.',
  'Tag another agent only when you need something from them: a question, a handoff, a task. Never tag to acknowledge, agree, or say you are ready. If nothing is actionable, do not reply.',
  'Tag the user only when you need a decision or input, or when the task they asked for is finished. Never tag for progress, acknowledgement, or questions the transcript already answers.',
  'Every MCP server mounted into this session is approved tool by tool - use operator and host tools freely; the read-only filesystem sandbox is the boundary, not a tool list. Network web search is enabled.',
  'Files and photos people share are downloaded for you: read them at the local path named in the prompt (photos may also arrive inline); never fetch the reference URL.',
  'To create a file (this Room has no other way to write one), call beeline-agent write_scratch_file with a relative path and content - text by default, or base64 for bytes you computed; it returns a path in your writable session home. To send a file, call beeline-agent attach_file with a path inside your checkout or anywhere in your writable session home (wherever a file you or your harness generated actually landed, including one you just wrote); it is attached to your reply. write_scratch_file produces the file, not a picture - turning it into a raster image needs a converter, which needs shell, which this Room does not have.',
  'To run something later or repeatedly, call beeline-agent create_schedule (interval in minutes or a 5-field cron, optional maxRuns); list_schedules / delete_schedule manage them.',
  `To react to things that HAPPEN in this Room rather than only to what is said to you, call beeline-agent subscribe_events with the kinds you want (${SERVER_EVENT_KINDS.join(', ')}); each one then wakes you for a turn. It replaces your list, so send every kind you want - list_event_subscriptions shows the current one. You do this yourself: nobody has to configure it for you. grant-decided carries the grant id and status and resumes the turn that asked for the grant.`,
  'To state something that happened so the Room and other agents can act on it, call beeline-agent emit_event with your own agent:<slug> kind, one sentence, and optionally the agent members to wake. Chains of events are bounded and a refused emit posts nothing.',
  'When repository work is needed, you MUST call beeline-agent open_corner with a name of at most three words - it titles the corner everywhere - and a complete objective of no more than 24 words. The host-governed call is the only way to start write work.',
  "Never open a corner from your own reading of a person's ask. For every ask, first reply on one line `Proposed corner: <name> — <objective>`, using the exact title and objective you would pass to open_corner, then stop and wait. If one message contains several asks, list one numbered `Proposed corner:` line per ask; `go on 1 and 3` opens exactly those objectives and leaves the others proposed. A person's `go`, `yes`, or equivalent opens exactly the proposed corner; if they edit it, their edited text is the objective. Skip this ceremony only when the message itself explicitly commands a corner and states its scope, such as `open a corner and do X` or `go build X in a corner`; open that scope immediately.",
  'Agreement is not action: never merely acknowledge an ask. Reply with a proposed corner, a question, or a line beginning `parked:` with the reason.',
  'When open_corner succeeds, the server posts the corner card: do not announce or restate the opening. End the turn with nothing more unless the person asked something else.',
  'Never claim an action or reply happened unless the prompt or a tool result proves it.',
].join(' ');

const BEELINE_DM_CAPABILITIES = [
  'This is a private direct-message conversation with one person. Every message they send is addressed to you; reply without tagging.',
  'This Room is strictly conversational: there is no repository binding and no corner can be opened from here.',
  'The repository filesystem is read-only in this session.',
  'Every MCP server mounted into this session is approved tool by tool - use operator and host tools freely; the read-only filesystem sandbox is the boundary, not a tool list. Network web search is enabled.',
  'Files and photos people share are downloaded for you: read them at the local path named in the prompt (photos may also arrive inline); never fetch the reference URL.',
  'To create a file (this Room has no other way to write one), call beeline-agent write_scratch_file with a relative path and content - text by default, or base64 for bytes you computed; it returns a path in your writable session home. To send a file, call beeline-agent attach_file with a path inside your checkout or anywhere in your writable session home (wherever a file you or your harness generated actually landed, including one you just wrote); it is attached to your reply. write_scratch_file produces the file, not a picture - turning it into a raster image needs a converter, which needs shell, which this Room does not have.',
  'Tag the person only when you need a decision or input, or when the task they asked for is finished.',
  'Never claim an action or reply happened unless the prompt or a tool result proves it.',
].join(' ');

export interface RepositoryPrimerInfo {
  name: string;
  branch: string;
}

export function beelinePrimer(repository?: RepositoryPrimerInfo, directMessage?: boolean): string {
  if (directMessage) {
    return (
      'Consult the release-versioned using-beeline skill (SKILL.md) when you need the managed ' +
      `Room mechanics. ${BEELINE_DM_CAPABILITIES}`
    );
  }
  const repositoryLine = repository
    ? ` This Room is bound to ${repository.name} (branch ${repository.branch}); you have a read-only checkout at the session root.`
    : '';
  return (
    'Consult the release-versioned using-beeline skill (SKILL.md) when you need the managed ' +
    `Room mechanics. ${BEELINE_ROOM_CAPABILITIES}${repositoryLine}`
  );
}

export const BEELINE_CAPABILITIES_PRIMER = beelinePrimer();

export interface BeelineCapabilityContext {
  sessionPrompt: string;
  compatibilityTurnPrefix?: string;
}

export function beelineCapabilityContextForHarness(
  agentCommand: string | undefined,
  repository?: RepositoryPrimerInfo,
  directMessage?: boolean,
): BeelineCapabilityContext {
  const primer = beelinePrimer(repository, directMessage);
  return {
    sessionPrompt: primer,
    ...(harnessHonorsSessionSystemPrompt(agentCommand) ? {} : { compatibilityTurnPrefix: primer }),
  };
}

export function runningBeelineReleaseId(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  try {
    const lib = env.BEELINE_LIB_DIR;
    if (!lib) return 'source';
    const manifest = JSON.parse(read(resolve(lib, 'bundle.json'))) as {
      version?: string;
      commit?: string;
    };
    return [manifest.version, manifest.commit].filter(Boolean).join('-') || 'source';
  } catch {
    return 'source';
  }
}

export function usingBeelineSkillMarkdown(releaseId: string): string {
  return `---
name: using-beeline
description: How to answer inside a Beeline Room.
---

<!-- beeline-release: ${releaseId} -->

# Using Beeline

You are answering inside a Room whose filesystem is read-only. ${BEELINE_ROOM_CAPABILITIES}
`;
}

export function beelineReviewSkillMarkdown(releaseId: string): string {
  return `---
name: beeline-review
description: Review a corner pull request against its objective and the Beeline merge gate.
---

<!-- beeline-release: ${releaseId} -->

# Beeline pull-request review

Follow these steps in order. Do not skip or reorder them.

## 1. Isolate the revision

- Run \`gh pr view N --json headRefOid,files\` and record \`headRefOid\`.
- Run \`gh pr diff N\`.
- Check out that exact head in a new scratch git worktree. Never use the author's worktree.
- Review and test only the recorded revision. If the head moves, start over.

## 2. P0 - OBJECTIVE FULFILLED, DEMONSTRATED

- Quote the corner objective verbatim.
- Derive its end-user story in one sentence: \`a user who does X sees Y\`.
- Make Y happen against the built PR head: run the app or affected service and perform X.
- If no interactive surface is reachable, run the narrowest test or script that exercises the exact user path and prints the observable Y.
- Record the command and the observed Y.
- A unit test of an inner function, a log line, \`the code looks right\`, or any other proxy does not count.
- If the user-visible Y cannot be produced, FAIL now. Nothing below can rescue the review.
- State whether the diff fulfills that objective and only that objective.

## 3. Empirical pass second

- Run the repository typecheck and tests touched by the diff.
- If the objective names a user path, exercise that path.
- Record every command and exit code.
- A review with no executed command is invalid and must FAIL.

## 4. Adversarial pass

- For every changed function, name one concrete input or sequence that breaks it.
- If none is found, write \`none found\` for that function.

## 5. Verify before reporting

- Confirm every finding by reading the exact line or by running a command.
- Put unconfirmed concerns under plausible findings. They never block.

## 6. Bloat guard

- Compare net lines with the objective.
- FAIL backwards-compatibility shims, dual paths, feature flags, or abstractions with one caller.
- FAIL machinery the objective did not ask for.

## 7. Security and data

- Check credentials, authorization boundaries, and destructive migrations.

## 8. Gate and verdict

- The merge gate is open only when \`pr_checks_status\` reports checks=passed, held=false, approvalPending=false.
- Green \`gh pr checks\` alone never opens the gate.
- Always use this exact verdict shape:

\`objective quoted:\`
\`user story:\`
\`how Y was demonstrated (or FAIL):\`
\`commands run + results:\`
\`critical findings (block):\`
\`plausible findings (do not block):\`
\`net lines:\`
\`decision: PASS|FAIL\`

Then take exactly one action:

- FAIL: reply \`@author\` with the confirmed findings; do not merge.
- PASS with pending checks: reply \`approved pending checks <reviewed sha>\` and stop.
- PASS with the gate open and your yolo on: run \`gh pr merge --squash --match-head-commit <reviewed sha> N\`.
- PASS with the gate open and your yolo off: reply \`approved <reviewed sha>\` and stop.
`;
}
