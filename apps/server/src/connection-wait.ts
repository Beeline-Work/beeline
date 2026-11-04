import { subscribeCommandCompletion, waitForCommittedChange, type CommandCompletionKey } from './command-completion.js';

/** Install committed-event interest before inspecting state once. The timeout
 * ends this admitted wait; it never causes another status read or retry. */
export async function waitForConnection<T>(read: () => Promise<T | undefined>, timeoutMs = 85_000,
  completion?: CommandCompletionKey, signal?: AbortSignal): Promise<T | undefined> {
  if (!completion) throw new Error('connection completion identity required');
  return waitForCommittedChange(listener => subscribeCommandCompletion(completion, listener), read, timeoutMs, signal);
}
