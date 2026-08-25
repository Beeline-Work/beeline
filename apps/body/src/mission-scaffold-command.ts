/**
 * `beeline mission-scaffold <dir>` — write the three-file mission convention
 * (Mission Charter v2 M1) into an existing directory.
 *
 * Deliberately boring: no provisioning, no relay access, no binding, no
 * landing. The human provisions and binds the mission repo; this command only
 * creates the convention files that are MISSING and refuses to touch anything
 * that exists. Output is deterministic for a given input, so a chief-of-staff
 * corner can run it safely and idempotently.
 */
import pc from 'picocolors';
import {
  applyMissionScaffoldPlan,
  planMissionScaffold,
  type MissionScaffoldInput,
} from './mission-scaffold.js';

export interface MissionScaffoldCommandDependencies {
  cwd: () => string;
  log: (message: string) => void;
  error: (message: string) => void;
}

const defaults: MissionScaffoldCommandDependencies = {
  cwd: () => process.cwd(),
  log: console.log,
  error: console.error,
};

function parseInput(args: string[]): { dir: string; input: MissionScaffoldInput } {
  let dir = '';
  const input: MissionScaffoldInput = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? '';
    const value = (): string => {
      const next = args[i + 1];
      if (next === undefined) throw new Error(`${token} requires a value`);
      i++;
      return next;
    };
    if (token === '--name') input.missionName = value();
    else if (token === '--objective') input.objective = value();
    else if (token === '--principal') input.principal = value();
    else if (token === '--chief') input.chiefOfStaff = value();
    else if (token.startsWith('--')) throw new Error(`unknown option: ${token}`);
    else if (dir) throw new Error('exactly one directory argument is allowed');
    else if (token !== undefined) dir = token;
  }
  return { dir: dir || '.', input };
}

/** Returns a process exit code: 0 on success, 1 on failure. */
export async function runMissionScaffoldCommand(
  args: string[],
  deps: MissionScaffoldCommandDependencies = defaults,
): Promise<number> {
  try {
    const { dir, input } = parseInput(args);
    const target = dir === '.' ? deps.cwd() : dir;
    const plan = await planMissionScaffold(target, input);
    await applyMissionScaffoldPlan(plan);
    for (const path of plan.skipped) {
      deps.log(`${pc.dim('preserved')} ${path}`);
    }
    for (const write of plan.writes) {
      deps.log(`${pc.green('created ')} ${write.path}`);
    }
    if (plan.writes.length === 0) {
      deps.log('mission convention files already present; nothing written');
    } else {
      deps.log(
        `\nNext: fill in the bootstrap sections (see the mission-brief skill), ` +
          `then commit on your feature branch.`,
      );
    }
    return 0;
  } catch (error) {
    deps.error(
      `mission-scaffold failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
