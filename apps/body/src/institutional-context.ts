import type { InstitutionalContextSnapshot } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';

export const INSTITUTIONAL_CONTEXT_TIMEOUT_MS = 200;
export const INSTITUTIONAL_MEMORY_LIVE_FLAG = 'BEELINE_INSTITUTIONAL_MEMORY_ENABLED';

/** Institutional memory is ON by default: the flag is an OFF switch, so only an
 *  explicit `false` disables it. */
export function institutionalMemoryFlagEnabled(
  env: NodeJS.ProcessEnv,
  flag: string,
): boolean {
  return env[flag] !== 'false';
}

export const EMPTY_INSTITUTIONAL_CONTEXT: InstitutionalContextSnapshot = {
  snapshotRevision: 0,
  text: '',
  itemIds: [],
  totalBytes: 0,
  omitted: {},
};

/** Memory is an optional context lane. It can never delay or fail the turn. */
export async function institutionalContextForTurn(
  api: Pick<DaemonApiClient, 'execute'>,
  roomId: string,
  log: (message: string) => void = console.warn,
  timeoutMs = INSTITUTIONAL_CONTEXT_TIMEOUT_MS,
  enabled = institutionalMemoryFlagEnabled(process.env, INSTITUTIONAL_MEMORY_LIVE_FLAG),
): Promise<InstitutionalContextSnapshot> {
  if (!enabled) return EMPTY_INSTITUTIONAL_CONTEXT;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      api.execute('getInstitutionalContext', { roomId }),
      new Promise<InstitutionalContextSnapshot>((_, reject) => {
        timer = setTimeout(() => reject(new Error('institutional context timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    log(
      `institutional context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EMPTY_INSTITUTIONAL_CONTEXT;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
