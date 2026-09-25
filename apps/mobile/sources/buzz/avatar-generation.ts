import { useSyncExternalStore } from 'react';

type Job = { pending: boolean; error: string | null };
const idle: Job = { pending: false, error: null };
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
function publish(agentId: string, job: Job) {
  jobs.set(agentId, job);
  for (const listener of listeners) listener();
}
export function useAvatarGeneration(agentId: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => jobs.get(agentId) ?? idle,
    () => idle,
  );
}
/** One optimistic request per agent across mounted profiles; the server command owns the durable exclusion. */
export async function runAvatarGeneration(
  agentId: string,
  run: () => Promise<void>,
): Promise<void> {
  if (jobs.get(agentId)?.pending) return;
  publish(agentId, { pending: true, error: null });
  try {
    await run();
    publish(agentId, idle);
  } catch (reason) {
    publish(agentId, {
      pending: false,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }
}
