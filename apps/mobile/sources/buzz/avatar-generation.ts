import { useSyncExternalStore } from 'react';

type Job = {
  pending: boolean;
  error: string | null;
  /** The saved avatar id the job started from; a different server id means it finished. */
  since?: string;
  /** The server has reported this job running, so its answer now owns the pending state. */
  serverSeen?: boolean;
};
type ServerAvatarState = { avatarGenerationId?: string; avatarGenerationPending?: boolean };
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
/**
 * The server flag is authoritative. The client job only bridges the gap between
 * starting a request and the server reporting it: a newer saved avatar, or any
 * answer after the server has seen the job running, ends the bridge.
 */
export function avatarGenerationShowsPending(job: Job, server: ServerAvatarState): boolean {
  if (server.avatarGenerationPending === true) return true;
  if (!job.pending || job.serverSeen) return false;
  return server.avatarGenerationId === job.since;
}
/** Record that the server reported the running job; later server answers own the state. */
export function noteServerAvatarGeneration(agentId: string, server: ServerAvatarState): void {
  const job = jobs.get(agentId);
  if (!job?.pending || job.serverSeen || server.avatarGenerationPending !== true) return;
  publish(agentId, { ...job, serverSeen: true });
}
/** One optimistic request per agent across mounted profiles; the server command owns the durable exclusion. */
export async function runAvatarGeneration(
  agentId: string,
  since: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  if (jobs.get(agentId)?.pending) return;
  publish(agentId, { pending: true, error: null, since });
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
