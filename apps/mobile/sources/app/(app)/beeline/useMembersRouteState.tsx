import { useSurfaceFocus } from '@/buzz/use-surface-focus';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { useIsDesktop } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isAgentDetailView, isAllowedAgentModelConfigCategory, isWorkspaceView, type AgentDetailView, type Identity, type WorkspaceView } from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { useWorkspaceRecords, workspaceRecordScope } from '@/buzz/workspace-records';
import { effortConfigAxis } from '@/buzz/agent-model-picker';
import { MembersAction, first, newerConfigVersion, ownerByline, ModelAxisKind } from './members';

type Props = [
  workspaceIdOverride: string | undefined,
  profileAgentId: string | undefined,
];
export function useMembersRouteState([
  workspaceIdOverride, profileAgentId,
]: Props): [
  identity: Identity | null,
  relayUrl: string | null,
  recordScope: string | null,
  setRosterQuery: React.Dispatch<React.SetStateAction<string>>,
  workspaceId: string | undefined,
  focused: boolean,
  setIdentity: React.Dispatch<React.SetStateAction<Identity | null>>,
  setRelayUrl: React.Dispatch<React.SetStateAction<string | null>>,
  focusedRef: React.RefObject<boolean>,
  setWorkspaceError: React.Dispatch<React.SetStateAction<string | null>>,
  readWorkspaceRef: React.RefObject<(() => Promise<void>) | null>,
  agentRequestGenerationRef: React.RefObject<number>,
  retryGeneration: number,
  setSelectedAgent: (value: AgentDetailView | null) => void,
  setEditingAgentSoul: React.Dispatch<React.SetStateAction<boolean>>,
  setOpenModelAxis: React.Dispatch<React.SetStateAction<ModelAxisKind | null>>,
  setModelAppliesNote: React.Dispatch<React.SetStateAction<ModelAxisKind | null>>,
  setYoloError: React.Dispatch<React.SetStateAction<string | null>>,
  setAccessError: React.Dispatch<React.SetStateAction<string | null>>,
  setLocalAgentId: React.Dispatch<React.SetStateAction<string | null>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
  profileRetryGeneration: number,
  surface: WorkspaceView | null,
  setWorking: React.Dispatch<React.SetStateAction<MembersAction | null>>,
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setPairCommand: React.Dispatch<React.SetStateAction<string | null>>,
  requestedActionHandledRef: React.RefObject<boolean>,
  requestedAction: string | undefined,
  memberQuery: string,
  setRosterLoading: React.Dispatch<React.SetStateAction<boolean>>,
  rosterLoading: boolean,
  selectedAgent: AgentDetailView | null,
  ownsSelectedAgent: boolean,
  editingAgentSoul: boolean,
  allowProfileNavigationRef: React.RefObject<boolean>,
  nameDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  soulDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  agentNameDraft: string,
  agentSoulDraft: string,
  navigation: Omit<import("@react-navigation/core").NavigationProp<ReactNavigation.RootParamList>, "getState"> & { getState(): import("@react-navigation/routers").NavigationState | undefined; },
  pendingConfigWriteRef: React.RefObject<boolean>,
  applyAgentReceipt: (value: AgentDetailView) => void,
  finishConfigWrite: (agentId: string) => void,
  modelAppliesTimerRef: React.RefObject<NodeJS.Timeout | null>,
  setModelAxisError: React.Dispatch<React.SetStateAction<ModelAxisKind | null>>,
  waitingForEffortCatalogRef: React.RefObject<boolean>,
  canRemoveSelectedAgent: boolean,
  error: string | null,
  workspaceError: string | null,
  working: MembersAction | null,
  setRetryGeneration: React.Dispatch<React.SetStateAction<number>>,
  setProfileRetryGeneration: React.Dispatch<React.SetStateAction<number>>,
  setAgentNameDraft: (update: string | ((previous: string) => string)) => void,
  setAgentSoulDraft: (update: string | ((previous: string) => string)) => void,
  params: { communityId?: string | string[]; roomId?: string | string[]; action?: string | string[]; },
  openModelAxis: ModelAxisKind | null,
  modelSearchQuery: string,
  setModelSearchQuery: (update: string | ((previous: string) => string)) => void,
  modelAppliesNote: ModelAxisKind | null,
  modelAxisError: ModelAxisKind | null,
  selectedAgentOwnerByline: string | undefined,
  theme: { dark: boolean; colors: { text: "#f0f0f3" | "#171310"; textSecondary: "#83838d" | "#8B7F6E"; textLink: "#b08a4a" | "#8a6323"; textDestructive: "#c4544d"; warning: "#b08a4a" | "#8a6323"; surface: "#14091A" | "#F3EEE4"; surfaceRipple: "#271c31" | "#E0D5BE"; surfacePressed: "#271c31" | "#E0D5BE"; surfaceSelected: "#1e1326" | "#E4D9C4"; surfacePressedOverlay: "#271c31" | "#E0D5BE"; surfaceHigh: "#190e21" | "#ECE4D5"; surfaceHighest: "#1e1326" | "#E4D9C4"; divider: "#291e33" | "#DED2BC"; groupped: { background: "#14091A" | "#F3EEE4"; chevron: "#83838d" | "#8B7F6E"; sectionTitle: "#83838d" | "#8B7F6E"; }; header: { background: "#14091A" | "#F3EEE4"; tint: "#f0f0f3" | "#171310"; }; input: { background: "#190e21" | "#ECE4D5"; text: "#f0f0f3" | "#171310"; placeholder: "#83838d" | "#8B7F6E"; }; button: { primary: { background: "#F3EDE3" | "#1C1712"; tint: "#F3EDE3" | "#1C1712"; disabled: "#6c6c76" | "#A79C89"; }; secondary: { tint: "#F3EDE3" | "#1C1712"; }; }; radio: { active: "#b08a4a" | "#8a6323"; inactive: "#3b3048" | "#C9BBA0"; dot: "#b08a4a" | "#8a6323"; }; status: { connecting: "#b08a4a" | "#8a6323"; disconnected: "#83838d" | "#8B7F6E"; error: "#c4544d"; default: "#83838d" | "#8B7F6E"; connected: "#b08a4a" | "#8a6323"; }; switch: { track: { active: "#b08a4a" | "#8a6323"; inactive: "#3b3048" | "#C9BBA0"; }; thumb: { active: "#14091A" | "#F3EEE4"; inactive: "#83838d" | "#8B7F6E"; }; }; userMessageBackground: "#1e1326" | "#E4D9C4"; userMessageText: "#f0f0f3" | "#171310"; agentMessageText: "#f0f0f3" | "#171310"; agentEventText: "#83838d" | "#8B7F6E"; gitBranchText: "#83838d" | "#8B7F6E"; gitFileCountText: "#83838d" | "#8B7F6E"; }; buzz: import("@/buzz/groknight").BeelineThemeTokens; },
  accessError: string | null,
  yoloError: string | null,
  insets: import("react-native-safe-area-context/lib/typescript/src/SafeArea.types").EdgeInsets,
  rosterQuery: string,
  desktop: boolean,
  setMemberQuery: (update: string | ((previous: string) => string)) => void,
  pickerOpen: boolean,
  pairCommand: string | null,
] {

  const focused = useSurfaceFocus();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useLatencyRouteFrame('/beeline/members');
  const desktop = useIsDesktop();
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    roomId?: string | string[];
    action?: string | string[];
  }>();
  const navigation = useNavigation();
  const workspaceId = workspaceIdOverride ?? first(params.communityId);
  const requestedAction = first(params.action);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [localAgentId, setLocalAgentId] = useState<string | null>(null);
  const workspaceAddress = useMemo(
    () =>
      identity && relayUrl && workspaceId
        ? surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id', { workspaceId })
        : null,
    [identity?.publicKey, relayUrl, workspaceId],
  );
  const agentId = profileAgentId ?? localAgentId;
  const agentAddress = useMemo(
    () =>
      identity && relayUrl && workspaceId && agentId
        ? surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id/agents/:agentId', {
            workspaceId,
            agentPubkey: agentId,
          })
        : null,
    [identity?.publicKey, relayUrl, workspaceId, agentId],
  );

  const cachedWorkspace=useSurfaceSnapshot((workspaceAddress),isWorkspaceView);
  const surface=(cachedWorkspace);

  const cachedAgent = useSurfaceSnapshot((agentAddress), isAgentDetailView);

  const selectedAgent = (cachedAgent);
  const setSelectedAgent = (value: AgentDetailView | null) => {

    if (!value) {
      setLocalAgentId(null);
      return;
    }
    setLocalAgentId(value.agent.identity.pubkey);
    if (identity && relayUrl && workspaceId)
      void mobileSurfaceCache.write(
        surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id/agents/:agentId', {
          workspaceId,
          agentPubkey: value.agent.identity.pubkey,
        }),
        value,
        isAgentDetailView,
      );
  };
  useLatencyRouteFrame(
    profileAgentId ? '/beeline/agent-profile' : '/beeline/members',
    profileAgentId ? selectedAgent !== null : surface !== null,
    true,
  );
  const [editingAgentSoul, setEditingAgentSoul] = useState(false);
  const [agentNameDraft, setAgentNameDraft, nameDraft] = useTextDraft(
    selectedAgent ? `agent-name:${workspaceId}:${selectedAgent.agent.identity.pubkey}` : null,
    '',
  );
  const [agentSoulDraft, setAgentSoulDraft, soulDraft] = useTextDraft(
    selectedAgent ? `agent-soul:${workspaceId}:${selectedAgent.agent.identity.pubkey}` : null,
    '',
  );
  const [openModelAxis, setOpenModelAxis] = useState<ModelAxisKind | null>(null);
  const [modelSearchQuery, setModelSearchQuery] = useTextDraft(
    `model-search:${workspaceId}:${selectedAgent?.agent.identity.pubkey ?? ''}`,
    '',
  );
  const [modelAppliesNote, setModelAppliesNote] = useState<ModelAxisKind | null>(null);
  const [modelAxisError, setModelAxisError] = useState<ModelAxisKind | null>(null);
  const modelAppliesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [working, setWorking] = useState<MembersAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [yoloError, setYoloError] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [profileRetryGeneration, setProfileRetryGeneration] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pairCommand, setPairCommand] = useState<string | null>(null);
  const [memberQuery, setMemberQuery] = useTextDraft(`member-search:${workspaceId}`, '');
  // Search selection is local; its ordered pages and rows live in the records.
  const [rosterQuery, setRosterQuery] = useState('');
  const [rosterLoading, setRosterLoading] = useState(false);
  const readWorkspaceRef = useRef<(() => Promise<void>) | null>(null);
  const agentRequestGenerationRef = useRef(0);
  const allowProfileNavigationRef = useRef(false);
  const requestedActionHandledRef = useRef(false);
  const waitingForEffortCatalogRef = useRef(false);
  const latestConfigVersionRef = useRef<string | undefined>(undefined);
  const pendingConfigWriteRef = useRef(false);
  const queuedConfigVersionRef = useRef<string | undefined>(undefined);
  latestConfigVersionRef.current = selectedAgent?.configVersion;
  const ownsSelectedAgent = selectedAgent?.access?.owner?.id === identity?.publicKey;
  const canRemoveSelectedAgent = (ownsSelectedAgent || Boolean(surface?.viewer.permissions.manage));
  const recordScope =
    identity && relayUrl && workspaceId
      ? workspaceRecordScope(relayUrl, identity.publicKey, workspaceId)
      : null;
  useWorkspaceRecords(recordScope);
  const selectedAgentOwnerByline = selectedAgent?.owner
    ? ownerByline(selectedAgent.owner)
    : undefined;

  const readAgent = async (agentPubkey: string): Promise<AgentDetailView> => {
    const generation = agentRequestGenerationRef.current;
    if (!focusedRef.current || AppState.currentState === 'background' || AppState.currentState === 'inactive' || !identity || !relayUrl || !workspaceId) throw new Error('Workspace connection unavailable');
    const value = await new RoomViewClient({ baseUrl: relayUrl, identity }).agent(
      workspaceId,
      agentPubkey,
    );
    if (generation !== agentRequestGenerationRef.current) return value;
    const address = surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id/agents/:agentId', {
      workspaceId,
      agentPubkey,
    });
    await mobileSurfaceCache.write(address, value, isAgentDetailView);
    return value;
  };

  const applyAgentReceipt = (value: AgentDetailView) => {
    agentRequestGenerationRef.current += 1;
    latestConfigVersionRef.current = value.configVersion;
    const queued = queuedConfigVersionRef.current;
    queuedConfigVersionRef.current = undefined;
    if ((queued) && newerConfigVersion(queued, value.configVersion))
      void readAgent(value.agent.identity.pubkey).catch(() => undefined);
    // The one write: the Workspace records hear it and update the roster row.
    setSelectedAgent(value);
  };

  const finishConfigWrite = (agentId: string) => {
    pendingConfigWriteRef.current = false;
    const queued = queuedConfigVersionRef.current;
    queuedConfigVersionRef.current = undefined;
    if ((queued) && newerConfigVersion(queued, latestConfigVersionRef.current))
      void readAgent(agentId).catch(() => undefined);
  };

  useEffect(() => {
    if ((!focused) || !selectedAgent || !identity || !relayUrl) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    const agentId = selectedAgent.agent.identity.pubkey;
    void sharedLiveConnection()
      .register([], (event) => {
        if (cancelled || AppState.currentState === 'background' || AppState.currentState === 'inactive' || !('monolithLive' in event)) return;
        const live = event.monolithLive;
        if (!(
          (live.type === 'resource-change' &&
            live.resource === 'agent' &&
            (!live.resourceId || live.resourceId === agentId)) ||
          (live.type === 'invalidate' && live.roomId === '' && live.reason === 'reconnect')
        ))
          return;
        if (live.type === 'resource-change' && live.version) {
          if (!newerConfigVersion(live.version, latestConfigVersionRef.current)) return;
          if (pendingConfigWriteRef.current) {
            if (newerConfigVersion(live.version, queuedConfigVersionRef.current))
              queuedConfigVersionRef.current = live.version;
            return;
          }
        }
        void readAgent(agentId)
          .then((detail) => {
            if (!waitingForEffortCatalogRef.current) return;
            const effort = effortConfigAxis(
              detail.catalog.filter(
                (candidate) =>
                  isAllowedAgentModelConfigCategory(candidate.category, candidate.id) &&
                  candidate.options.length > 0,
              ),
            );
            if (effort) {
              waitingForEffortCatalogRef.current = false;
              setWorking(null);
              setOpenModelAxis('effort');
            }
          })
          .catch((reason) => {
            if (!cancelled) setError(appErrorCopy(reason));
          });
      })
      .then((release) => {
        if (cancelled) release();
        else stop = release;
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [focused, identity, relayUrl, selectedAgent?.agent.identity.pubkey]);
return [
    identity, relayUrl, recordScope, setRosterQuery, workspaceId, focused, setIdentity, setRelayUrl,
    focusedRef, setWorkspaceError, readWorkspaceRef, agentRequestGenerationRef, retryGeneration,
    setSelectedAgent, setEditingAgentSoul, setOpenModelAxis, setModelAppliesNote, setYoloError,
    setAccessError, setLocalAgentId, setError, profileRetryGeneration, surface, setWorking,
    setPickerOpen, setPairCommand, requestedActionHandledRef, requestedAction, memberQuery,
    setRosterLoading, rosterLoading, selectedAgent, ownsSelectedAgent, editingAgentSoul,
    allowProfileNavigationRef, nameDraft, soulDraft, agentNameDraft, agentSoulDraft, navigation,
    pendingConfigWriteRef, applyAgentReceipt, finishConfigWrite, modelAppliesTimerRef,
    setModelAxisError, waitingForEffortCatalogRef, canRemoveSelectedAgent, error, workspaceError,
    working, setRetryGeneration, setProfileRetryGeneration, setAgentNameDraft, setAgentSoulDraft,
    params, openModelAxis, modelSearchQuery, setModelSearchQuery, modelAppliesNote, modelAxisError,
    selectedAgentOwnerByline, theme, accessError, yoloError, insets, rosterQuery, desktop,
    setMemberQuery, pickerOpen, pairCommand,
  ];
}
