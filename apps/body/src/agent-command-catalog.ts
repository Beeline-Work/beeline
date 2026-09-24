import { DRAW_AVATAR_COMMAND } from './draw-avatar-skill.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { AcpAvailableCommand } from './acp.js';

/**
 * Bridge one ACP full-snapshot notification into the server-owned agent row.
 * Publication is deliberately non-blocking: command metadata must never hold
 * up or fail the agent turn that caused a harness session to start.
 */
export function agentCommandCatalogPublisher(input: {
  api: DaemonApiClient;
  agentId: string;
  workspaceId: string;
  report?: (error: unknown) => void;
}): (commands: readonly AcpAvailableCommand[]) => void {
  return (commands) => {
    void input.api
      .execute('postAgentCommands', {
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        commands: [
          ...commands.filter(
            (command) => command.name.replace(/^\//, '') !== DRAW_AVATAR_COMMAND.name,
          ),
          DRAW_AVATAR_COMMAND,
        ],
      })
      .catch(
        input.report ??
          ((error) => console.error('[body] agent command catalog publish failed:', error)),
      );
  };
}
