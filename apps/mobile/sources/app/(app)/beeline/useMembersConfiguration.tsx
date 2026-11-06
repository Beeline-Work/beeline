import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useEffect } from 'react';
import { router } from 'expo-router';
import { type AgentDetailView, type AgentModelConfigInput, type AgentModelConfigOption } from '@beeline/buzz-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { recordWorkspaceRemoval } from '@/buzz/workspace-records';
import { Modal } from '@/modal/ModalManager';
import { MembersAction, ModelAxisKind, MODEL_APPLIES_NOTE_MS, modelSelectionInput } from './members';

type Props = [
  modelAppliesTimerRef: React.RefObject<NodeJS.Timeout | null>,
  setModelAppliesNote: React.Dispatch<React.SetStateAction<ModelAxisKind | null>>,
  selectedAgent: AgentDetailView | null,
  ownsSelectedAgent: boolean,
  readModelAxes: () => { model: import("@beeline/api-contract/phone").AgentModelConfigOption | undefined; effort: import("@beeline/api-contract/phone").AgentModelConfigOption | undefined; fast: import("@beeline/api-contract/phone").AgentModelConfigOption | undefined; },
  setWorking: React.Dispatch<React.SetStateAction<MembersAction | null>>,
  pendingConfigWriteRef: React.RefObject<boolean>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
  writeClient: () => Promise<import("@beeline/buzz-client").BuzzClient & { refreshAgentModelCatalog(workspaceId: string, agentId: string): Promise<unknown>; }>,
  applyAgentReceipt: (value: AgentDetailView) => void,
  setOpenModelAxis: React.Dispatch<React.SetStateAction<ModelAxisKind | null>>,
  finishConfigWrite: (agentId: string) => void,
  setModelAxisError: React.Dispatch<React.SetStateAction<ModelAxisKind | null>>,
  waitingForEffortCatalogRef: React.RefObject<boolean>,
  setSelectedAgent: (value: AgentDetailView | null) => void,
  setYoloError: React.Dispatch<React.SetStateAction<string | null>>,
  setAccessError: React.Dispatch<React.SetStateAction<string | null>>,
  canRemoveSelectedAgent: boolean,
  workspaceId: string | undefined,
  recordScope: string | null,
  closeAgentSettings: () => void,
  profileAgentId: string | undefined,
  onClose: (() => void) | undefined,
];
export function useMembersConfiguration([
  modelAppliesTimerRef, setModelAppliesNote, selectedAgent, ownsSelectedAgent, readModelAxes,
  setWorking, pendingConfigWriteRef, setError, writeClient, applyAgentReceipt, setOpenModelAxis,
  finishConfigWrite, setModelAxisError, waitingForEffortCatalogRef, setSelectedAgent, setYoloError,
  setAccessError, canRemoveSelectedAgent, workspaceId, recordScope, closeAgentSettings,
  profileAgentId, onClose,
]: Props): [
  toggleModelAxis: (kind: ModelAxisKind, open: boolean, axis: AgentModelConfigOption | undefined) => Promise<void>,
  setModelOption: (kind: ModelAxisKind, choiceId: string) => Promise<void>,
  setFastMode: (enabled: boolean) => Promise<void>,
  toggleAnswersEveryone: (everyone: boolean) => Promise<void>,
  toggleYolo: (enabled: boolean) => Promise<void>,
  removeSelectedAgent: () => Promise<void>,
] {


  const showModelAppliesNote = (kind: ModelAxisKind) => {
    if (modelAppliesTimerRef.current) clearTimeout(modelAppliesTimerRef.current);
    setModelAppliesNote(kind);
    modelAppliesTimerRef.current = setTimeout(() => {
      modelAppliesTimerRef.current = null;
      setModelAppliesNote(null);
    }, MODEL_APPLIES_NOTE_MS);
  };
  useEffect(
    () => () => {
      if (modelAppliesTimerRef.current) clearTimeout(modelAppliesTimerRef.current);
    },
    [],
  );

  const setModelOption = async (kind: ModelAxisKind, choiceId: string) => {
    if (!selectedAgent || !ownsSelectedAgent) return;
    const axis = kind === 'model' ? readModelAxes().model : readModelAxes().effort;
    const input: AgentModelConfigInput =
      kind === 'model' ? modelSelectionInput(selectedAgent, axis, choiceId) : { effort: choiceId };
    setWorking('model-config');
    pendingConfigWriteRef.current = true;
    setError(null);
    try {
      const pubkey = selectedAgent.agent.identity.pubkey;
      const client = await writeClient();
      const receipt = await client.setAgentModelConfig(selectedAgent.workspaceId, pubkey, input);
      applyAgentReceipt(receipt as unknown as AgentDetailView);
      setOpenModelAxis(null);
      showModelAppliesNote(kind);
    } catch (reason) {
      setError(appErrorCopy(reason, `Could not set ${kind}.`));
    } finally {
      finishConfigWrite(selectedAgent.agent.identity.pubkey);
      setWorking(null);
    }
  };

  const setFastMode = async (enabled: boolean) => {
    if (!selectedAgent || !ownsSelectedAgent || !readModelAxes().fast) return;
    setWorking('model-config');
    pendingConfigWriteRef.current = true;
    setError(null);
    try {
      const pubkey = selectedAgent.agent.identity.pubkey;
      const client = await writeClient();
      const receipt = await client.setAgentModelConfig(selectedAgent.workspaceId, pubkey, {
        fastMode: enabled,
      });
      applyAgentReceipt(receipt as unknown as AgentDetailView);
    } catch (reason) {
      setError(appErrorCopy(reason, `Could not set Fast mode.`));
    } finally {
      finishConfigWrite(selectedAgent.agent.identity.pubkey);
      setWorking(null);
    }
  };

  const toggleModelAxis = async (
    kind: ModelAxisKind,
    open: boolean,
    axis: AgentModelConfigOption | undefined,
  ) => {
    setModelAxisError(null);
    if (open) {
      setOpenModelAxis(null);
      return;
    }
    if (axis) {
      setOpenModelAxis(kind);
      return;
    }
    if (kind !== 'effort' || !selectedAgent || !ownsSelectedAgent) return;

    setWorking('model-catalog');
    try {
      const pubkey = selectedAgent.agent.identity.pubkey;
      const client = await writeClient();
      waitingForEffortCatalogRef.current = true;
      await client.refreshAgentModelCatalog(selectedAgent.workspaceId, pubkey);
      // The helper's catalog write has its own committed agent change event.
    } catch {
      waitingForEffortCatalogRef.current = false;
      setModelAxisError('effort');
    } finally {
      if (!waitingForEffortCatalogRef.current) setWorking(null);
    }
  };

  const toggleYolo = async (enabled: boolean) => {
    const yolo = selectedAgent?.yolo;
    if (!selectedAgent || !yolo?.canChange) return;
    const previous = selectedAgent;
    const pubkey = previous.agent.identity.pubkey;
    // Optimistic: the switch settles now; the indexed read confirms or the
    // catch below rolls back with the server's own message inline.
    setSelectedAgent({ ...previous, yolo: { ...yolo, enabled } });
    setWorking('agent-yolo');
    pendingConfigWriteRef.current = true;
    setYoloError(null);
    try {
      const receipt = await monolithPhoneOperation('updateAgentYolo', {
        workspaceId: previous.workspaceId,
        agentId: pubkey,
        enabled,
      });
      applyAgentReceipt(receipt);
    } catch (reason) {
      setSelectedAgent(previous);
      setYoloError(appErrorCopy(reason));
    } finally {
      finishConfigWrite(pubkey);
      setWorking(null);
    }
  };

  const toggleAnswersEveryone = async (everyone: boolean) => {
    const access = selectedAgent?.access;
    if (!selectedAgent || !access?.canChange) return;
    const previous = selectedAgent;
    const pubkey = previous.agent.identity.pubkey;
    const policy = everyone ? 'everyone' : 'creator';
    // Optimistic like the yolo switch: the row settles now and the indexed read
    // confirms, or the catch rolls it back with the server's own message inline.
    setSelectedAgent({ ...previous, access: { ...access, policy } });
    setWorking('agent-access');
    pendingConfigWriteRef.current = true;
    setAccessError(null);
    try {
      const receipt = await monolithPhoneOperation('updateAgentAccessPolicy', {
        workspaceId: previous.workspaceId,
        agentId: pubkey,
        policy,
      });
      applyAgentReceipt(receipt);
    } catch (reason) {
      setSelectedAgent(previous);
      setAccessError(appErrorCopy(reason));
    } finally {
      finishConfigWrite(pubkey);
      setWorking(null);
    }
  };

  // An agent is removed, never banned: a ban only blocks this identity, and
  // its owner can pair the same helper back as a new agent at any time.
  const removeSelectedAgent = async () => {
    if (!selectedAgent || !canRemoveSelectedAgent || !workspaceId) return;
    const pubkey = selectedAgent.agent.identity.pubkey;
    const name = selectedAgent.agent.identity.name;
    await Modal.confirm(
      `Remove ${name}?`,
      'This removes the agent from every Room and the Workspace. The paired host then confirms that removal, drains active sessions, stops the daemon, and deletes its runtime configuration. Re-pairing is required to restore it.',
      {
        cancelText: 'Cancel', confirmText: 'Remove agent', destructive: true, pendingText: 'Removing…',
        onConfirm: async () => {
          setWorking('remove-agent');
          setError(null);
          try {
            const client = await writeClient();
            await client.removeAgent(workspaceId, pubkey);
            if (recordScope) recordWorkspaceRemoval(recordScope, pubkey);
            closeAgentSettings();
            if (profileAgentId) (onClose ?? (() => router.back()))();
            setOpenModelAxis(null);
          } catch (reason) {
            throw new Error(appErrorCopy(reason, 'Could not remove agent.'));
          } finally {
            setWorking(null);
          }
        },
      },
    );
  };
return [
    toggleModelAxis, setModelOption, setFastMode, toggleAnswersEveryone, toggleYolo,
    removeSelectedAgent,
  ];
}
