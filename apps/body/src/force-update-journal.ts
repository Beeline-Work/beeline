import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DaemonApiError, type DaemonApiClient } from './daemon-api-client.js';

export type InterruptedTurn = {
  roomId: string;
  requestId: string;
  generationId: string;
};

const NAME = 'force-update-interruptions.json';

function pathFor(runtimeDir: string): string {
  return resolve(runtimeDir, NAME);
}

function read(runtimeDir: string): InterruptedTurn[] {
  try {
    const rows: unknown = JSON.parse(readFileSync(pathFor(runtimeDir), 'utf8'));
    if (!Array.isArray(rows)) throw new Error('invalid force-update interruption journal');
    return rows.map((row) => {
      if (!row || typeof row !== 'object') throw new Error('invalid interrupted turn');
      const turn = row as Record<string, unknown>;
      if (typeof turn.roomId !== 'string' || typeof turn.requestId !== 'string' ||
          typeof turn.generationId !== 'string') throw new Error('invalid interrupted turn');
      return { roomId: turn.roomId, requestId: turn.requestId, generationId: turn.generationId };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function write(runtimeDir: string, rows: readonly InterruptedTurn[]): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const target = pathFor(runtimeDir);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

/** Persist the interrupted commands before the old process releases the install. */
export function journalInterruptedTurns(runtimeDir: string, turns: readonly InterruptedTurn[]): void {
  if (!turns.length) return;
  const rows = read(runtimeDir);
  const seen = new Set(rows.map((row) => `${row.roomId}:${row.requestId}:${row.generationId}`));
  for (const turn of turns) {
    const key = `${turn.roomId}:${turn.requestId}:${turn.generationId}`;
    if (!seen.has(key)) rows.push(turn);
    seen.add(key);
  }
  write(runtimeDir, rows);
}

/** The successor reports each interruption before opening intake; the server requeues it. */
export async function reportInterruptedTurns(
  runtimeDir: string,
  api: Pick<DaemonApiClient, 'execute'>,
  agentId: string,
): Promise<void> {
  const rows = read(runtimeDir);
  while (rows.length) {
    const row = rows[0]!;
    const receipt = {
      agentId,
      ...row,
      status: 'failed',
      reason: 'interrupted by update',
      reasonKind: 'update-interrupted',
    } as const;
    try {
      await api.execute('postAgentTurnReceipt', receipt);
    } catch (error) {
      if (!staleGeneration(error)) throw error;
      // A long archive install may outlive the server's old generation lease.
      // Its watchdog has already reopened the same command. The pending path
      // accepts a generation-free failure receipt and gives the Room the
      // update interruption line before the new helper claims it.
      try {
        const { generationId: _generationId, ...pendingReceipt } = receipt;
        await api.execute('postAgentTurnReceipt', pendingReceipt);
      } catch (retryError) {
        if (!staleGeneration(retryError)) throw retryError;
        // The original turn completed or was cancelled just before the
        // minimum rose. It is terminal; replay must not block other turns.
      }
    }
    rows.shift();
    write(runtimeDir, rows);
  }
}

function staleGeneration(error: unknown): boolean {
  return error instanceof DaemonApiError && error.status === 403 &&
    /command output authority rejected|command turn cancelled/.test(error.code);
}
