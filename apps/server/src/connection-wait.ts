import { subscribeCommandCompletion, waitForCommittedChange, type CommandCompletionKey } from './command-completion.js';

/** Install committed-event interest before inspecting state once. */
export async function waitForConnection<T>(read: () => Promise<T | undefined>,
  completion?: CommandCompletionKey, signal?: AbortSignal): Promise<T | undefined> {
  if (!completion) throw new Error('connection completion identity required');
  return waitForCommittedChange(listener => subscribeCommandCompletion(completion, listener), read, signal);
}
