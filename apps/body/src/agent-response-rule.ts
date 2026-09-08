import { AGENT_TO_AGENT_HOP_CAP } from '@beeline/api-contract/daemon';

export interface ResponseRuleMessage {
  readonly id: string;
  readonly authorId: string;
  readonly type: string;
  readonly mentionIds: readonly string[];
  readonly replyToMessageId?: string;
  readonly replyToAuthorId?: string;
  readonly requestAuthorId?: string;
  readonly agentHopCount?: number;
}

/** The one conversational response rule shared by top-level Rooms and corners. */
export class AgentResponseRule {
  private agentIds = new Set<string>();
  private readonly lastAgentBySender = new Map<string, string>();
  private readonly observedIds = new Set<string>();

  setAgents(agentIds: Iterable<string>): void {
    this.agentIds = new Set(agentIds);
  }

  observeAll(items: readonly ResponseRuleMessage[]): void {
    for (const item of items) this.observe(item);
  }

  observe(item: ResponseRuleMessage): void {
    if (this.observedIds.has(item.id)) return;
    this.observedIds.add(item.id);
    if (item.type !== 'message' || !this.agentIds.has(item.authorId)) return;

    const addressed = new Set(item.mentionIds);
    if (item.requestAuthorId) addressed.add(item.requestAuthorId);
    if (item.replyToAuthorId) addressed.add(item.replyToAuthorId);
    for (const senderId of addressed) {
      if (senderId !== item.authorId) this.lastAgentBySender.set(senderId, item.authorId);
    }
  }

  /** Record a just-published reply without waiting for the daemon inbox to echo it. */
  noteReply(agentId: string, senderId: string): void {
    if (agentId !== senderId) this.lastAgentBySender.set(senderId, agentId);
  }

  /** Whether trigger 2 applies. Explicit mention handling stays with each intake loop. */
  continues(item: ResponseRuleMessage, agentId: string): boolean {
    if (item.type !== 'message' || item.authorId === agentId) return false;
    if (this.lastAgentBySender.get(item.authorId) !== agentId) return false;
    if (item.replyToMessageId) return item.replyToAuthorId === agentId;
    if (this.agentIds.has(item.authorId) && (item.agentHopCount ?? 0) >= AGENT_TO_AGENT_HOP_CAP)
      return false;
    return true;
  }
}
