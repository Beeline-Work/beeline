import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { activeCommandOwner, canonical } from './command-owner';

type Operation = 'clearNeedsYou' | 'clearNeedsYouSection' | 'clearMessageBookmarks' | 'setMessageBookmark' |
  'decideAgentGrant' | 'decideWritePermission' | 'skipChoice';
export type TrayCommand = { [Name in Operation]: { operation: Name; input: PhoneOperationMap[Name]['input'] } }[Operation];
export interface PreparedTrayCommand {
  readonly ready: Promise<void>;
  deliver(): Promise<void>;
  cancel(): Promise<void>;
}

/** Retained write adapter: persist immutable intent during the gesture, before
 * the existing Undo window. It requires no read lane, snapshot or certificate. */
export function prepareTrayCommand(command: TrayCommand): PreparedTrayCommand | undefined {
  const owner = activeCommandOwner();
  if (!owner?.canPrepare()) return;
  const record = owner.prepare({ wire: { operation: command.operation, input: canonical(command.input) },
    isCurrent: () => activeCommandOwner() === owner });
  let cancelled = false;
  const ready = record.then(() => undefined);
  void ready.catch(() => undefined);
  let delivery: Promise<void> | undefined;
  return {
    ready,
    deliver: () => delivery ??= (async () => {
      const value = await record;
      if (!cancelled) await owner.deliver(value.id);
    })(),
    cancel: async () => { cancelled = true; await owner.cancel((await record).id); },
  };
}
