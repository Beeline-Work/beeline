import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { AGENT_NAME_MAX_LENGTH, isReasonableAgentName, type AgentDetailView, type Identity } from '@beeline/buzz-client';
import { BuzzRigTransport } from '@/sync/transport';
import { Modal } from '@/modal/ModalManager';
import { MembersAction, agentSoulCopy } from './members';

type Props = [
  identity: Identity | null,
  workspaceId: string | undefined,
  selectedAgent: AgentDetailView | null,
  ownsSelectedAgent: boolean,
  editingAgentSoul: boolean,
  allowProfileNavigationRef: React.RefObject<boolean>,
  nameDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  soulDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  setEditingAgentSoul: React.Dispatch<React.SetStateAction<boolean>>,
  agentNameDraft: string,
  agentSoulDraft: string,
  onClose: (() => void) | undefined,
  messagePerson: (pubkey: string) => Promise<void>,
  profileAgentId: string | undefined,
  navigation: Omit<import("@react-navigation/core").NavigationProp<ReactNavigation.RootParamList>, "getState"> & { getState(): import("@react-navigation/routers").NavigationState | undefined; },
  setError: React.Dispatch<React.SetStateAction<string | null>>,
  setWorking: React.Dispatch<React.SetStateAction<MembersAction | null>>,
  pendingConfigWriteRef: React.RefObject<boolean>,
  writeClient: () => Promise<import("@beeline/buzz-client").BuzzClient & { refreshAgentModelCatalog(workspaceId: string, agentId: string): Promise<unknown>; }>,
  applyAgentReceipt: (value: AgentDetailView) => void,
  finishConfigWrite: (agentId: string) => void,
];
export function useMembersSoul([
  identity, workspaceId, selectedAgent, ownsSelectedAgent, editingAgentSoul,
  allowProfileNavigationRef, nameDraft, soulDraft, setEditingAgentSoul, agentNameDraft,
  agentSoulDraft, onClose, messagePerson, profileAgentId, navigation, setError, setWorking,
  pendingConfigWriteRef, writeClient, applyAgentReceipt, finishConfigWrite,
]: Props): [
  closeAgentProfile: () => Promise<void>,
  messageSelectedAgent: () => Promise<void>,
  requestSoulAvatar: (soul: string) => Promise<void>,
  beginAgentSoulEdit: () => void,
  saveAgentSoul: () => Promise<boolean>,
] {


  // The soul reaches the agent through the server: unsaved edits are saved
  // first and the agent draws from its saved soul. The visible request stays
  // a short "/draw-avatar" and never carries the soul text.
  const requestSoulAvatar = async (soul: string) => {
    if (!identity || !workspaceId || !selectedAgent || !ownsSelectedAgent)
      throw new Error('Agent settings are unavailable.');
    if (!soul.trim()) throw new Error('The soul is empty; set a soul before generating an avatar.');
    if (editingAgentSoul && agentEditDirty && !(await saveAgentSoul()))
      throw new Error('Could not save the soul for avatar generation.');
    const client = new BuzzRigTransport(identity);
    const agent = selectedAgent.agent.identity;
    const room = await client.resolveDirectMessage(workspaceId, agent.pubkey);
    const message = await client.composeMessage(
      {
        sessionId: room.channelId,
        text: '/draw-avatar',
      },
      { mentionAgent: agent.pubkey },
    );
    await client.publishPreparedMessage(message);
  };

  const beginAgentSoulEdit = () => {
    if (!selectedAgent || !ownsSelectedAgent) return;
    allowProfileNavigationRef.current = false;
    nameDraft.initialize(selectedAgent.soul?.name ?? selectedAgent.agent.identity.name);
    soulDraft.initialize(agentSoulCopy(selectedAgent));
    setEditingAgentSoul(true);
  };

  const agentEditDirty = Boolean(
    editingAgentSoul &&
    selectedAgent &&
    (agentNameDraft !== (selectedAgent.soul?.name ?? selectedAgent.agent.identity.name) ||
      agentSoulDraft !== agentSoulCopy(selectedAgent)),
  );
  const confirmDiscardAgentEdit = async (): Promise<boolean> => {
    if (!agentEditDirty) return true;
    const clearName = nameDraft.capture();
    const clearSoul = soulDraft.capture();
    const confirmed = await Modal.confirm(
      'Discard agent changes?',
      'Your name and soul edits have not been saved.',
      {
        cancelText: 'Keep editing',
        confirmText: 'Discard',
        destructive: true,
      },
    );
    if (confirmed) {
      clearName();
      clearSoul();
    }
    return confirmed;
  };
  const closeAgentProfile = async () => {
    if (!(await confirmDiscardAgentEdit())) return;
    allowProfileNavigationRef.current = true;
    setEditingAgentSoul(false);
    (onClose ?? (() => router.back()))();
  };
  const messageSelectedAgent = async () => {
    if (!(await confirmDiscardAgentEdit())) return;
    allowProfileNavigationRef.current = true;
    setEditingAgentSoul(false);
    await messagePerson(profileAgentId!);
    allowProfileNavigationRef.current = false;
  };

  useEffect(() => {
    if (!profileAgentId || !agentEditDirty) return;
    return navigation.addListener('beforeRemove', (event) => {
      if (allowProfileNavigationRef.current) return;
      event.preventDefault();
      void confirmDiscardAgentEdit().then((confirmed) => {
        if (!confirmed) return;
        allowProfileNavigationRef.current = true;
        setEditingAgentSoul(false);
        navigation.dispatch(event.data.action);
      });
    });
  }, [navigation, profileAgentId, agentEditDirty]);

  useEffect(() => {
    if (!profileAgentId || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeAgentProfile();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [profileAgentId, agentEditDirty, onClose]);

  const saveAgentSoul = async (): Promise<boolean> => {
    if (!selectedAgent || !ownsSelectedAgent || !workspaceId) return false;
    const name = agentNameDraft.trim().slice(0, AGENT_NAME_MAX_LENGTH);
    const soul = agentSoulDraft.trim();
    if (!isReasonableAgentName(name)) {
      setError('Agent name must be a short spoken name.');
      return false;
    }
    if (!soul) {
      setError('Agent soul instructions cannot be empty.');
      return false;
    }
    const clearName = nameDraft.capture(false);
    const clearSoul = soulDraft.capture(false);
    setWorking('save-agent-soul');
    pendingConfigWriteRef.current = true;
    setError(null);
    try {
      const pubkey = selectedAgent.agent.identity.pubkey;
      const client = await writeClient();
      const receipt = await client.setAgentSoul(workspaceId, pubkey, {
        name,
        soul,
        avatarSeed: selectedAgent.soul?.avatarSeed ?? pubkey,
        ...(selectedAgent.soul?.avatar ? { avatar: selectedAgent.soul.avatar } : {}),
      });
      applyAgentReceipt(receipt as unknown as AgentDetailView);
      clearName();
      clearSoul();
      setEditingAgentSoul(false);
      return true;
    } catch (reason) {
      setError(appErrorCopy(reason, `Could not save agent settings.`));
      return false;
    } finally {
      finishConfigWrite(selectedAgent.agent.identity.pubkey);
      setWorking(null);
    }
  };
return [
    closeAgentProfile, messageSelectedAgent, requestSoulAvatar, beginAgentSoulEdit, saveAgentSoul,
  ];
}
