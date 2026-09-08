import { AGENT_TO_AGENT_HOP_CAP } from '@beeline/api-contract/daemon';

export const INBOX_DEDUPLICATION_LIMIT = 10_000;
export const CONTINUITY_WINDOW_LIMIT = 200;

export interface ResponseRuleMessage {
  readonly id: string;
  readonly authorId: string;
  readonly type: string;
  readonly mentionIds: readonly string[];
  readonly agentMentionIds?: readonly string[];
  readonly agentAuthor?: boolean;
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
  private readonly recentMessages: ResponseRuleMessage[] = [];
  private localReplySequence = 0;

  setAgents(agentIds: Iterable<string>): void {
    this.agentIds = new Set(agentIds);
    this.rebuildLastAgentBySender();
  }

  observeAll(items: readonly ResponseRuleMessage[]): void {
    for (const item of items) this.observe(item);
  }

  replaceHistory(items: readonly ResponseRuleMessage[]): void {
    this.recentMessages.length = 0;
    this.lastAgentBySender.clear();
    for (const item of items) this.record(item);
  }

  observe(item: ResponseRuleMessage): void {
    if (this.observedIds.has(item.id)) return;
    this.observedIds.add(item.id);
    while (this.observedIds.size > INBOX_DEDUPLICATION_LIMIT)
      this.observedIds.delete(this.observedIds.values().next().value!);
    this.record(item);
  }

  private record(item: ResponseRuleMessage): void {
    if (item.type !== 'message') return;
    this.recentMessages.push(item);
    while (this.recentMessages.length > CONTINUITY_WINDOW_LIMIT) this.recentMessages.shift();
    this.rebuildLastAgentBySender();
  }

  private rebuildLastAgentBySender(): void {
    this.lastAgentBySender.clear();
    for (const recent of this.recentMessages) {
      if (!recent.agentAuthor && !this.agentIds.has(recent.authorId)) continue;
      const addressed = new Set(recent.mentionIds);
      if (recent.requestAuthorId) addressed.add(recent.requestAuthorId);
      if (recent.replyToAuthorId) addressed.add(recent.replyToAuthorId);
      for (const senderId of addressed) {
        if (senderId !== recent.authorId) this.lastAgentBySender.set(senderId, recent.authorId);
      }
    }
  }

  noteReply(agentId: string, senderIds: Iterable<string>): void {
    this.record({
      id: `local-reply-${agentId}-${this.localReplySequence++}`,
      authorId: agentId,
      type: 'message',
      mentionIds: [...senderIds],
      agentAuthor: true,
    });
  }

  /** Whether trigger 2 applies. Explicit mention handling stays with each intake loop. */
  continues(item: ResponseRuleMessage, agentId: string): boolean {
    if (item.type !== 'message' || item.authorId === agentId) return false;
    if (!this.agentIds.has(agentId)) return false;
    if (
      (item.agentAuthor || this.agentIds.has(item.authorId)) &&
      (item.agentHopCount ?? 0) >= AGENT_TO_AGENT_HOP_CAP
    )
      return false;
    if (
      item.agentMentionIds?.length ||
      item.mentionIds.some((mentioned) => this.agentIds.has(mentioned))
    )
      return false;
    if (item.replyToMessageId) return item.replyToAuthorId === agentId;
    if (this.lastAgentBySender.get(item.authorId) !== agentId) return false;
    return true;
  }
}
