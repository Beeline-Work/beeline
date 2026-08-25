/**
 * Deterministic mission-repo scaffold (Mission Charter v2, build item M1).
 *
 * Generates the three-file convention the `mission-brief` chief-of-staff skill
 * teaches — `objective.md`, `state.md`, `org-chart.md` — with useful,
 * non-placeholder structure derived purely from its input. No timestamps, no
 * randomness: the same input always produces the same bytes, and a second run
 * over a scaffolded repo changes nothing.
 *
 * Authority boundary (charter M1): the HUMAN provisions and binds the mission
 * repo once. This generator only writes the three convention files into an
 * existing directory. It never provisions, binds, authorizes, clones, or lands
 * anything, and it never overwrites or deletes existing files — human mission
 * state always wins.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { MISSION_FILES } from './mission-skill.js';

/** Input for one scaffold generation; every field is optional and bounded. */
export interface MissionScaffoldInput {
  /** Short mission name used in every file's title. Defaults to `Mission`. */
  missionName?: string;
  /** The one-sentence objective, when it is already known. */
  objective?: string;
  /** The human principal's name or handle. */
  principal?: string;
  /** The chief-of-staff agent's name or handle. */
  chiefOfStaff?: string;
}

const DEFAULT_MISSION_NAME = 'Mission';
const UNKNOWN = '(capture during the bootstrap interview)';

function line(value: string | undefined, fallback = UNKNOWN): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/** `objective.md` — the durable WHY. Changes only when the human changes the mission. */
export function objectiveMarkdown(input: MissionScaffoldInput): string {
  return `# Mission objective — ${line(input.missionName, DEFAULT_MISSION_NAME)}

<!-- Durable WHY. This file changes only when the human changes the mission.
     Time-sensitive status belongs in state.md; people belong in org-chart.md.
     Large data lives as ordinary files in this repo, referenced by path. -->

## One-sentence objective

${input.objective?.trim() || UNKNOWN}

## Success criteria

<!-- Observable by the principal. A criterion the human cannot check is not a criterion. -->

- ${UNKNOWN}

## Scope boundaries

### In scope

- ${UNKNOWN}

### Out of scope / non-goals

- ${UNKNOWN}

## Constraints

- Budget: ${UNKNOWN}
- Deadlines / checkpoints: ${UNKNOWN}
- Hard limits (things that must never happen): ${UNKNOWN}

## Authority

The chief of staff operates under the human's written mission grant and does
nothing beyond what that grant names; anything else escalates to the human
(see the mission-brief skill).
`;
}

/** `state.md` — the current WHERE. Updated routinely; git history is the audit trail. */
export function stateMarkdown(input: MissionScaffoldInput): string {
  return `# Mission state — ${line(input.missionName, DEFAULT_MISSION_NAME)}

<!-- Current WHERE. Update routinely and commit after every material change;
     git history is the audit trail, so append rather than rewrite. -->

## Phase

BOOTSTRAP — assembling the brief from the one-sentence objective.

## Active work

| Item | Owner | Pointer (path or commit) | Status |
| --- | --- | --- | --- |
| Bootstrap interview | ${line(input.chiefOfStaff, 'chief of staff')} | ./objective.md | in progress |

## Decisions log (append-only)

<!-- One line per decision: date — decision — who decided — why. Never delete lines. -->

## Open blockers / escalations

- None.

## Next checkpoint

- Confirm success criteria and constraints with ${line(input.principal, 'the principal')},
  then move the phase to OPERATING.
`;
}

/** `org-chart.md` — the WHO. Principal, hub, spokes, and the communication rules. */
export function orgChartMarkdown(input: MissionScaffoldInput): string {
  return `# Mission org chart — ${line(input.missionName, DEFAULT_MISSION_NAME)}

<!-- WHO. Hub-and-spoke: spokes communicate ONLY with the chief of staff; the
     chief of staff communicates with the human. Messages carry pointers into
     this repo, not payloads. -->

## Principal (human)

- Handle: ${line(input.principal)}
- Decides: objective changes, scope, budget, escalations.

## Chief of staff (hub)

- Agent: ${line(input.chiefOfStaff)}
- Holds: exactly the authority the human's mission grant names — nothing more.
- Does: runs the bootstrap interview, maintains state.md, brokers all spoke
  coordination, rolls progress up to the principal.

## Spokes

<!-- One block per spoke agent. Add each spoke only once the principal names it. -->

### (spoke name)

- Responsibility: ${UNKNOWN}
- May do independently: ${UNKNOWN}
- Must escalate: anything outside its responsibility, any spend, any contact
  with the principal's decisions.

## Communication rules

- Spokes talk only to the chief of staff; the chief of staff talks to the human.
- No spoke-to-spoke or spoke-to-human channels; the hub brokers requests.
- Pointers over payloads: reference repo paths and commits instead of pasting
  content into messages.
- Roll-ups over chatter: periodic summaries of state deltas, not per-step noise.
`;
}

/**
 * Compute the scaffold plan for `dir`: the exact missing convention files to
 * write and the existing files (if any) that are preserved untouched. Reads
 * the directory; writes nothing.
 */
export async function planMissionScaffold(
  dir: string,
  input: MissionScaffoldInput = {},
): Promise<MissionScaffoldPlan> {
  const root = resolve(dir);
  let existing: Set<string>;
  try {
    existing = new Set(await readdir(root));
  } catch (error) {
    throw new Error(`mission repo directory is not readable: ${root}`, { cause: error });
  }

  const contents: Record<(typeof MISSION_FILES)[number], string> = {
    'objective.md': objectiveMarkdown(input),
    'state.md': stateMarkdown(input),
    'org-chart.md': orgChartMarkdown(input),
  };

  const writes = MISSION_FILES.filter((name) => !existing.has(name)).map((name) => ({
    path: join(root, name),
    content: contents[name],
  }));
  const skipped = MISSION_FILES.filter((name) => existing.has(name)).map((name) =>
    join(root, name),
  );
  return { dir: root, writes, skipped };
}

export interface MissionScaffoldPlan {
  dir: string;
  /** Missing convention files, with their full deterministic content. */
  writes: Array<{ path: string; content: string }>;
  /** Existing convention files that were preserved untouched. */
  skipped: string[];
}

/**
 * Execute a plan: write only the planned files. Existing files were already
 * excluded by `planMissionScaffold` and are never opened for writing.
 */
export async function applyMissionScaffoldPlan(plan: MissionScaffoldPlan): Promise<void> {
  for (const write of plan.writes) {
    if (!isAbsolute(write.path) || relative(plan.dir, write.path).startsWith('..')) {
      throw new Error(`refusing to write outside the mission repo: ${write.path}`);
    }
    await writeFile(write.path, write.content, { flag: 'wx' });
  }
}

/** Convenience wrapper: plan, then write the missing convention files. */
export async function scaffoldMissionRepo(
  dir: string,
  input: MissionScaffoldInput = {},
): Promise<MissionScaffoldPlan> {
  const plan = await planMissionScaffold(dir, input);
  await applyMissionScaffoldPlan(plan);
  return plan;
}
