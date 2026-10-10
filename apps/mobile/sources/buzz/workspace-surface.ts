import type { AgentDetailView, WorkspaceView } from '@beeline/buzz-client';

type WorkspaceAgentView = WorkspaceView['agents'][number];

/** The label the server's Workspace roster names for an agent's selected model. */
export function selectedModelLabel(detail: Pick<AgentDetailView, 'catalog' | 'selected'>): string | undefined {
  const axis = detail.catalog.find((candidate) => candidate.category === 'model');
  const value = detail.selected?.model ?? axis?.currentValue;
  if (!value) return undefined;
  return axis?.options?.find((option) => option.id === value)?.name ?? value;
}

/** The Workspace roster row an agent write receipt describes. */
export function workspaceAgentFromDetail(
  current: WorkspaceAgentView,
  detail: AgentDetailView,
): WorkspaceAgentView {
  const { model: _model, owner: _owner, ...member } = current;
  const model = selectedModelLabel(detail);
  return {
    ...member,
    identity: detail.agent.identity,
    ...(model ? { model } : {}),
    ...(detail.owner ? { owner: detail.owner } : {}),
  };
}
