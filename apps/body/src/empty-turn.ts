/**
 * One explanation for an ACP turn that completed without answer text.
 *
 * "ACP turn produced no durable Room reply" was the only fact the daemon had
 * when pi-acp swallowed a provider refusal (`pi-turn-record.ts`). Every empty
 * turn now resolves to either recovered answer text or a named reason: pi's
 * own record of the turn when the harness is pi-acp, the ACP stream's shape
 * (`describeEmptyTurn`) otherwise. The Room and corner loops post the reason
 * with the failed receipt; the update probe uses the record's class to tell a
 * model-side refusal from a broken bundle.
 */
import { describeEmptyTurn, isPiAcpHarness, type PromptResult } from './acp.js';
import { readPiTurnRecord, type PiTurnRecord } from './pi-turn-record.js';

export interface EmptyTurnExplanation {
  /** Answer text the harness recorded but never streamed; sanitize before use. */
  recoveredText?: string;
  /** One line, safe for a failure reason after `distillTurnFailureReason`. */
  reason: string;
  /** pi's record when the harness is pi-acp and the record was readable. */
  record?: PiTurnRecord;
}

export async function explainEmptyAgentTurn(input: {
  agentLabel: string | undefined;
  agentEnv: Record<string, string>;
  sessionId: string;
  result: PromptResult;
}): Promise<EmptyTurnExplanation> {
  const streamFact = describeEmptyTurn(input.result, input.agentLabel);
  if (!isPiAcpHarness(input.agentLabel)) return { reason: streamFact };
  const record = await readPiTurnRecord({ agentEnv: input.agentEnv, sessionId: input.sessionId });
  if (!record) return { reason: `pi left no readable turn record; ${streamFact}` };
  switch (record.kind) {
    case 'error':
      return { reason: record.reason, record };
    case 'empty':
      return {
        reason: `the model ended its turn with no text (stop reason ${record.stopReason})`,
        record,
      };
    case 'answer':
      return {
        recoveredText: record.text,
        reason: 'pi recorded the answer but the ACP stream delivered no text',
        record,
      };
    case 'missing':
      return { reason: `pi recorded no assistant message for this turn; ${streamFact}`, record };
  }
}

/**
 * HTTP refusals the account or the provider owns: an exhausted balance, a bad
 * or revoked key, a rate limit, a request timeout, or a provider outage. A
 * bundle cannot cause these, so the update probe treats them as the model's
 * own answer. A 400/404/422 or a status-less failure stays a possible bundle
 * fault (a malformed request from a bad models.json override, a sandbox that
 * cut the network) and keeps failing the probe.
 */
export function isAccountOrProviderRefusal(record: PiTurnRecord | undefined): boolean {
  if (!record || record.kind !== 'error' || record.status === undefined) return false;
  return [401, 402, 403, 407, 408, 429].includes(record.status) || record.status >= 500;
}
