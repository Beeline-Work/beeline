import type { PromptResult, SessionUpdate } from './acp.js';

/** Every model invocation must name the human-authorized event that caused it. */
export type ModelTurnCause =
  | 'room-message'
  | 'corner-metadata'
  | 'corner-opening'
  | 'corner-follow-up'
  | 'target-sync'
  | 'restart-continuation'
  | 'agent-exchange';

export interface ModelTurnAttribution {
  /** Event that immediately caused this invocation. */
  requestId: string;
  /** Original human request when the immediate cause is a bounded continuation. */
  originalRequestId: string;
  cause: ModelTurnCause;
}

export interface ModelTurnSpend extends ModelTurnAttribution {
  agentPubkey: string;
  channelId: string;
  startedAt: string;
  status: 'complete' | 'failed';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** ACP usage is preferred; otherwise the observable prompt/text is estimated at 4 chars/token. */
  tokenSource: 'reported' | 'estimated';
  toolCalls: number;
  error?: string;
}

interface TokenPair {
  input: number;
  output: number;
}

function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function tokenPair(value: unknown): TokenPair | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const input = finiteTokenCount(
    record.inputTokens ?? record.input_tokens ?? record.promptTokens ?? record.prompt_tokens,
  );
  const output = finiteTokenCount(
    record.outputTokens ?? record.output_tokens ?? record.completionTokens ?? record.completion_tokens,
  );
  if (input === undefined && output === undefined) return undefined;
  return { input: input ?? 0, output: output ?? 0 };
}

/** Last/cumulative usage update wins; maxima avoid double-counting streaming snapshots. */
export function reportedTokenUsage(updates: readonly SessionUpdate[]): TokenPair | undefined {
  let found: TokenPair | undefined;
  for (const { update } of updates) {
    const meta =
      update._meta && typeof update._meta === 'object' && !Array.isArray(update._meta)
        ? (update._meta as Record<string, unknown>)
        : undefined;
    for (const candidate of [update.usage, update.tokenUsage, meta?.usage, update]) {
      const pair = tokenPair(candidate);
      if (!pair) continue;
      found = {
        input: Math.max(found?.input ?? 0, pair.input),
        output: Math.max(found?.output ?? 0, pair.output),
      };
    }
  }
  return found;
}

function approximateTokens(characters: number): number {
  return Math.ceil(Math.max(0, characters) / 4);
}

function toolCallCount(result: PromptResult): number {
  const ids = new Set<string>();
  let anonymous = 0;
  for (const { update } of result.updates) {
    if (update.sessionUpdate !== 'tool_call') continue;
    if (typeof update.toolCallId === 'string' && update.toolCallId) ids.add(update.toolCallId);
    else anonymous++;
  }
  return ids.size + anonymous;
}

export function completedModelSpend(input: {
  result: PromptResult;
  prompt: string;
  systemPromptChars: number;
  attribution: ModelTurnAttribution;
  agentPubkey: string;
  channelId: string;
  startedAt: string;
}): ModelTurnSpend {
  const reported = reportedTokenUsage(input.result.updates);
  const inputTokens = reported?.input ?? approximateTokens(input.systemPromptChars + input.prompt.length);
  const outputTokens = reported?.output ?? approximateTokens(input.result.agentText.length);
  return {
    ...input.attribution,
    agentPubkey: input.agentPubkey,
    channelId: input.channelId,
    startedAt: input.startedAt,
    status: 'complete',
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    tokenSource: reported ? 'reported' : 'estimated',
    toolCalls: toolCallCount(input.result),
  };
}

export function failedModelSpend(input: {
  prompt: string;
  systemPromptChars: number;
  attribution: ModelTurnAttribution;
  agentPubkey: string;
  channelId: string;
  startedAt: string;
  error: unknown;
}): ModelTurnSpend {
  const inputTokens = approximateTokens(input.systemPromptChars + input.prompt.length);
  return {
    ...input.attribution,
    agentPubkey: input.agentPubkey,
    channelId: input.channelId,
    startedAt: input.startedAt,
    status: 'failed',
    inputTokens,
    outputTokens: 0,
    totalTokens: inputTokens,
    tokenSource: 'estimated',
    toolCalls: 0,
    error: String(input.error).slice(0, 500),
  };
}

export interface AgentDailySpend {
  agentPubkey: string;
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reportedCalls: number;
  estimatedCalls: number;
  toolCalls: number;
  turns: ModelTurnSpend[];
}

export interface SessionReprimeRecord {
  agentPubkey: string;
  channelId: string;
  processGeneration: string;
  at: string;
  entries: number;
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
}

export interface RestartReprimeSpend {
  agentPubkey: string;
  day: string;
  processGeneration: string;
  count: number;
  beforeTokens: number;
  afterTokens: number;
  records: SessionReprimeRecord[];
}

export function dailyAgentSpend(
  turns: readonly ModelTurnSpend[],
  day: string,
): AgentDailySpend[] {
  const byAgent = new Map<string, AgentDailySpend>();
  for (const turn of turns) {
    if (turn.startedAt.slice(0, 10) !== day) continue;
    const report = byAgent.get(turn.agentPubkey) ?? {
      agentPubkey: turn.agentPubkey,
      day,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reportedCalls: 0,
      estimatedCalls: 0,
      toolCalls: 0,
      turns: [],
    };
    report.calls++;
    report.inputTokens += turn.inputTokens;
    report.outputTokens += turn.outputTokens;
    report.totalTokens += turn.totalTokens;
    report.toolCalls += turn.toolCalls;
    if (turn.tokenSource === 'reported') report.reportedCalls++;
    else report.estimatedCalls++;
    report.turns.push(turn);
    byAgent.set(turn.agentPubkey, report);
  }
  const reports = [...byAgent.values()];
  for (const report of reports) {
    report.turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  return reports.sort((a, b) => a.agentPubkey.localeCompare(b.agentPubkey));
}

export function dailyRestartReprimes(
  records: readonly SessionReprimeRecord[],
  day: string,
): RestartReprimeSpend[] {
  const grouped = new Map<string, RestartReprimeSpend>();
  for (const record of records) {
    if (record.at.slice(0, 10) !== day) continue;
    const key = `${record.agentPubkey}\0${record.processGeneration}`;
    const report = grouped.get(key) ?? {
      agentPubkey: record.agentPubkey,
      day,
      processGeneration: record.processGeneration,
      count: 0,
      beforeTokens: 0,
      afterTokens: 0,
      records: [],
    };
    report.count++;
    report.beforeTokens += record.beforeTokens;
    report.afterTokens += record.afterTokens;
    report.records.push(record);
    grouped.set(key, report);
  }
  return [...grouped.values()].sort(
    (a, b) =>
      a.agentPubkey.localeCompare(b.agentPubkey) ||
      a.processGeneration.localeCompare(b.processGeneration),
  );
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}…` : value;
}

/** Plain-text operator surface: totals first, then every causal turn. */
export function formatAgentSpendReport(reports: readonly AgentDailySpend[]): string {
  if (reports.length === 0) return 'No model calls recorded for this day.';
  return reports
    .flatMap((report) => [
      `${report.day} agent=${report.agentPubkey} calls=${report.calls} ` +
        `tokens=${report.totalTokens} (input=${report.inputTokens} output=${report.outputTokens}; ` +
        `reported=${report.reportedCalls} estimated=${report.estimatedCalls}) tools=${report.toolCalls}`,
      ...report.turns.map((turn) => {
        const estimate = turn.tokenSource === 'estimated' ? '~' : '';
        return (
          `  ${turn.startedAt.slice(11, 19)} ${turn.cause} status=${turn.status} ` +
          `tokens=${estimate}${turn.totalTokens} tools=${turn.toolCalls} ` +
          `request=${shortId(turn.requestId)} original=${shortId(turn.originalRequestId)}`
        );
      }),
    ])
    .join('\n');
}

export function formatReprimeReport(reports: readonly RestartReprimeSpend[]): string {
  if (reports.length === 0) return 'No session re-primes recorded for this day.';
  return reports
    .map(
      (report) =>
        `${report.day} agent=${report.agentPubkey} restart=${report.processGeneration} ` +
        `re-primes=${report.count} before=${report.beforeTokens} after=${report.afterTokens} tokens`,
    )
    .join('\n');
}
