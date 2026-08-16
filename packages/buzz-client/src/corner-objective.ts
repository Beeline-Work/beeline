/**
 * A corner's persistent objective banner: the task it was opened for, plus
 * (when the agent's ACP harness surfaces one) a live multi-step plan whose
 * items flip from pending/in_progress to completed as the agent works.
 * Parameterized-replaceable so each corner retains one current record
 * instead of crowding chat history, mirroring agent-presence/agent-draft.
 */
export type CornerObjectiveStepStatus = 'pending' | 'in_progress' | 'completed';

export type CornerObjectiveStep = {
  content: string;
  status: CornerObjectiveStepStatus;
};

export type CornerObjective = {
  channelId: string;
  agentPubkey: string;
  objective: string;
  steps: CornerObjectiveStep[];
  observedAt: number;
};
