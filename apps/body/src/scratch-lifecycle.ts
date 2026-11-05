import { execFile } from 'node:child_process';
import {lstat} from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const CORNER_SCRATCH_BUDGET_BYTES = 5 * 1024 ** 3;

/** du counts allocated blocks once per inode and never follows symlinks. */
export async function allocatedDirectoryBytes(path: string): Promise<number> {
  if (!(await lstat(path).catch(() => undefined))) return 0;
  const output = await execFileAsync('du', ['-s', '-B1', '--', path], {
    maxBuffer: 1024 * 1024,
  }).then((result) => result.stdout);
  const bytes = Number(output.split(/\s+/)[0]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('scratch usage could not be measured');
  return bytes;
}

export function scratchBudgetMessage(usage: number, budget = CORNER_SCRATCH_BUDGET_BYTES): string {
  const mib = (bytes: number) => Math.ceil(bytes / 1024 ** 2);
  return `Scratch ${mib(usage)} / ${mib(budget)} MiB; Use scratch_status and your shell to inspect, update or delete files. ${usage > budget ? 'OVER BUDGET: remove files before writing more.' : ''}`.trim();
}

/** Existing oversized scratch stays available for a cleanup turn. */
export function scratchGrowthExceedsBudget(
  usage: number,
  atTurnStart: number,
  budget = CORNER_SCRATCH_BUDGET_BYTES,
): boolean {
  return usage > budget && usage > atTurnStart;
}

export async function assertScratchWriteBudget(
  root: string,
  incomingBytes: number,
  budget = CORNER_SCRATCH_BUDGET_BYTES,
): Promise<void> {
  const usage = await allocatedDirectoryBytes(root);
  if (usage + incomingBytes > budget) {
    throw new Error(`${scratchBudgetMessage(usage, budget)} Requested write: ${incomingBytes} bytes.`);
  }
}
