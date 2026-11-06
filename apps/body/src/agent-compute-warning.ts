import { availableParallelism, freemem } from 'node:os';

/** A setup advisory, never admission control: each active harness is roughly 500 MiB. */
export function agentComputeWarning(
  agents: number,
  availableMemoryBytes = freemem(),
  cores = availableParallelism(),
): string | undefined {
  const gib = 1024 ** 3;
  const estimatedMemory = agents * 512 * 1024 ** 2;
  if (estimatedMemory <= availableMemoryBytes * 0.75 && agents <= cores * 2) return;
  return `${agents} agents may need about ${(estimatedMemory / gib).toFixed(1)} GiB with ${Math.max(0, availableMemoryBytes / gib).toFixed(1)} GiB available and ${cores} CPU cores; simultaneous work may slow this machine. Setup will continue.`;
}
