import type { AgentCommand, DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { DaemonApiClient, InboxItem } from './daemon-api-client.js';

/** Convert the explicitly supplied work in older session-mechanics fixtures to
 * protocol commands. Routing eligibility is tested against the real server.
 * This adapter is test-only and never participates in production intake. */
export function commandFixtureApi(
  api: DaemonApiClient,
  roomId: string,
  agentId: string,
  objective?: string | null,
): DaemonApiClient {
  const pending = new Map<string, AgentCommand>(),
    seen = new Set<string>();
  let started = false,
    settled = objective === null,
    closed = false;
  let notify: ((commands: readonly AgentCommand[]) => void) | undefined;
  function add(source: InboxItem, reason = 'human_tag') {
    const fixture = source as InboxItem & {
      fixtureCommand?: boolean;
      fixtureCommandAction?: 'input' | 'resume' | 'stop';
      fixtureTurnRequestId?: string;
    };
    if (fixture.fixtureCommand === false || seen.has(source.id)) return;
    seen.add(source.id);
    const command: AgentCommand = {
      id: source.id,
      roomId,
      agentId,
      sourceMessageId: source.id,
      turnRequestId: fixture.fixtureTurnRequestId ?? source.id,
      action: fixture.fixtureCommandAction ?? 'input',
      reason,
      rootCommandId: source.id,
      rootSourceMessageId: source.id,
      agentDepth: 0,
      source,
    };
    pending.set(source.id, command);
    notify?.([command]);
  }
  if (objective)
    add(
      {
        id: roomId.replaceAll('-', ''),
        authorId: agentId,
        createdAt: 1,
        type: 'message',
        body: objective,
        attachments: [],
      },
      'corner_objective',
    );
  return new Proxy(api, {
    get(target, key) {
      if (key === 'liveSubscribe')
        return (...args: unknown[]) => {
          const onItems = args[2] as
            | ((items: readonly InboxItem[], cursor?: string) => void)
            | undefined;
          notify = args[5] as ((commands: readonly AgentCommand[]) => void) | undefined;
          args[2] = (items: readonly InboxItem[], cursor?: string) => {
            for (const source of items) add(source);
            onItems?.(items, cursor);
          };
          return target.liveSubscribe?.(...(args as Parameters<DaemonApiClient['liveSubscribe']>));
        };
      if (key !== 'execute') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (name: keyof DaemonOperationMap, input: Record<string, unknown>) => {
        if (name === 'getAgentCommands') {
          const page = await target.execute('getRoomInbox', {
            roomId,
            ...(!started ? { startAtLatest: true } : {}),
          });
          started = true;
          closed ||= page.closeRequested === true;
          for (const source of page.items ?? []) add(source);
          return { commandProtocol: 1, commands: [...pending.values()] };
        }
        if (name === 'claimAgentCommand') {
          settled = false;
          pending.delete(String(input.commandId));
          return { id: input.commandId, createdAt: 1 };
        }
        if (name === 'acknowledgeAgentCommand') return { id: input.commandId, createdAt: 1 };
        if (name === 'getCornerRestoreState' && closed && settled && !pending.size)
          return { cornerId: roomId, closeRequested: true };
        if (
          name === 'getCornerRestoreState' &&
          objective !== undefined &&
          settled &&
          !pending.size
        ) {
          const page = await target.execute('getCornerCloseRequests', { cornerId: roomId });
          for (const source of page.items ?? []) add(source);
          return { cornerId: roomId, closeRequested: page.closeRequested ?? false };
        }
        const result = await target.execute(name, input as never);
        if (name === 'postAgentTurnReceipt' && input.status !== 'working') settled = true;
        return result;
      };
    },
  });
}
