import React, { useMemo } from 'react';
import { router, type Href } from 'expo-router';
import { isAllowedAgentModelConfigCategory, type AgentDetailView, type AgentModelConfigOption, type WorkspaceView } from '@beeline/buzz-client';
import { effortConfigAxis, fastModeConfigAxis } from '@/buzz/agent-model-picker';
import { MembersAction } from './members';

type Props = [
  selectedAgent: AgentDetailView | null,
  error: string | null,
  workspaceError: string | null,
  working: MembersAction | null,
  surface: WorkspaceView | null,
  workspaceId: string | undefined,
];
export function useMembersPresentation([
  selectedAgent, error, workspaceError, working, surface, workspaceId,
]: Props): [
  modelAxes: { model: import("@beeline/api-contract/phone").AgentModelConfigOption | undefined; effort: import("@beeline/api-contract/phone").AgentModelConfigOption | undefined; fast: import("@beeline/api-contract/phone").AgentModelConfigOption | undefined; },
  displayedError: string | null,
  busy: boolean,
  openRosterPerson: (pubkey: string) => void,
  openRosterAgent: (pubkey: string) => void,
] {


  const modelAxes = useMemo(() => {
    const advertisedModel = selectedAgent?.catalog.find(
      (axis) => axis.category === 'model',
    )?.currentValue;
    const selectedModel = selectedAgent?.selected?.model ?? selectedAgent?.runtimeSelection?.model;
    const awaitingSelectedModelCatalog =
      Boolean(advertisedModel) && Boolean(selectedModel) && advertisedModel !== selectedModel;
    const live =
      selectedAgent?.catalog.filter(
        (axis) =>
          isAllowedAgentModelConfigCategory(axis.category, axis.id) && axis.options.length > 0,
      ) ?? [];
    return {
      model: live.find((axis) => axis.category === 'model'),
      // Effort choices may be model-specific. After a model switch, offer
      // nothing until the agent republishes a catalog whose current model
      // matches the persisted human selection.
      effort: awaitingSelectedModelCatalog ? undefined : effortConfigAxis(live),
      fast: awaitingSelectedModelCatalog ? undefined : fastModeConfigAxis(live),
    };
  }, [selectedAgent]);

  const displayedError = error ?? workspaceError;
  const busy = working !== null;
  const viewerPubkey = surface?.viewer.identity.pubkey;
  const openRosterPerson = React.useCallback(
    (pubkey: string) => {
      router.push({
        pathname: pubkey === viewerPubkey ? '/beeline/settings' : '/beeline/human-profile',
        params: { communityId: workspaceId, memberId: pubkey },
      } as Href);
    },
    [viewerPubkey, workspaceId],
  );
  const openRosterAgent = React.useCallback(
    (pubkey: string) => {
      router.push({
        pathname: '/beeline/agent-profile',
        params: { communityId: workspaceId, agentId: pubkey },
      } as Href);
    },
    [workspaceId],
  );
return [
    modelAxes, displayedError, busy, openRosterPerson, openRosterAgent,
  ];
}
