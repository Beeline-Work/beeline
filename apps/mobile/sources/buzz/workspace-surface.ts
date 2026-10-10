import {
  isWorkspaceListView,
  isWorkspaceView,
  type AgentDetailView,
  type ChatListWorkspace,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';

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

/**
 * Patch one agent in the shared `/workspace/:id` entry so every mounted reader
 * (Members under a profile, Room bylines, mention menu) repaints at once.
 * `null` removes the agent.
 */
export async function patchWorkspaceAgent(
  relayUrl: string,
  viewerPubkey: string,
  workspaceId: string,
  agentPubkey: string,
  detail: AgentDetailView | null,
): Promise<void> {
  const address = surfaceAddress(relayUrl, viewerPubkey, '/workspace/:id', { workspaceId });
  const current = await mobileSurfaceCache.read(address, isWorkspaceView);
  if (!current) return;
  const index = current.agents.findIndex((agent) => agent.identity.pubkey === agentPubkey);
  if (index < 0) return;
  const agents = detail
    ? current.agents.map((agent, at) => (at === index ? workspaceAgentFromDetail(agent, detail) : agent))
    : current.agents.filter((_, at) => at !== index);
  const next: WorkspaceView = {
    ...current,
    agents,
    ...(!detail && current.agentTotal !== undefined
      ? { agentTotal: Math.max(0, current.agentTotal - 1) }
      : {}),
  };
  await mobileSurfaceCache.write(address, next, isWorkspaceView);
}

/** Copy a fresh Workspace header into the `/workspaces` entry the rail paints. */
export async function syncWorkspaceListEntry(
  relayUrl: string,
  viewerPubkey: string,
  workspace: ChatListWorkspace,
): Promise<void> {
  const address = surfaceAddress(relayUrl, viewerPubkey, '/workspaces');
  const current = await mobileSurfaceCache.read(address, isWorkspaceListView);
  const listed = current?.workspaces.find((item) => item.id === workspace.id);
  if (!current || !listed) return;
  if (listed.name === workspace.name && listed.avatar === workspace.avatar) return;
  const { avatar: _avatar, ...rest } = listed;
  const entry: ChatListWorkspace = {
    ...rest,
    name: workspace.name,
    ...(workspace.avatar ? { avatar: workspace.avatar } : {}),
  };
  await mobileSurfaceCache.write(
    address,
    { ...current, workspaces: current.workspaces.map((item) => (item.id === workspace.id ? entry : item)) },
    isWorkspaceListView,
  );
}
