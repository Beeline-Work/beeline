import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { Codec } from './wire-codec.js';
import { routeCodecs } from './route-codecs.js';

function closed<T extends object>(codec: Codec<T>, fields: Readonly<Record<keyof T, true>>): Codec<T> {
  return Object.freeze({ parse(value: unknown): T {
    const parsed = codec.parse(value); // Budget/descriptor validation precedes any field inspection.
    if (Object.keys(parsed).some(key => !Object.hasOwn(fields, key))) throw new Error('Turn operation unknown input field');
    return parsed;
  } });
}
const claim = routeCodecs('daemon.claimAgentCommand');
const claimResult: typeof claim.result = Object.freeze({ parse(value: unknown) {
  const parsed = claim.result.parse(value);
  const credential = (parsed as { modelCredential?: unknown }).modelCredential;
  if (credential !== undefined) {
    if (!credential || typeof credential !== 'object' || Array.isArray(credential) ||
        Object.keys(credential).sort().join() !== 'expiresAt,token,v') throw new Error('Turn model credential shape invalid');
    const model = credential as { v?: unknown; token?: unknown; expiresAt?: unknown };
    if (model.v !== 1 || typeof model.token !== 'string' || !/^bfmc_v1\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(model.token) ||
        typeof model.expiresAt !== 'number' || !Number.isSafeInteger(model.expiresAt) || model.expiresAt <= 0 ||
        model.expiresAt > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) throw new Error('Turn model credential invalid');
  }
  return parsed;
} });
const receipt = routeCodecs('daemon.postAgentTurnReceipt');
const acknowledge = routeCodecs('daemon.acknowledgeAgentCommand');
const claimFields = { roomId: true, commandId: true, generationId: true } as const satisfies Record<keyof DaemonOperationMap['claimAgentCommand']['input'], true>;
const receiptFields = {
  agentId: true, roomId: true, requestId: true, generationId: true, status: true,
  trace: true, completionKind: true, heartbeat: true, reason: true,
  inputTokens: true, promptBytes: true, totalInputTokens: true, outputTokens: true,
  modelCalls: true, modelCallsWithoutUsage: true, toolCalls: true, reasonKind: true,
} as const satisfies Record<keyof DaemonOperationMap['postAgentTurnReceipt']['input'], true>;
const codecs = Object.freeze({
  claimAgentCommand: Object.freeze({ ...claim, result: claimResult, params: closed(claim.params, claimFields) }),
  acknowledgeAgentCommand: Object.freeze({ ...acknowledge, params: closed(acknowledge.params, claimFields) }),
  postAgentTurnReceipt: Object.freeze({ ...receipt, params: closed(receipt.params, receiptFields) }),
});
/** Only these existing turn controls, at the two owned machine adapters. */
export function helperTurnCodecs<K extends keyof typeof codecs>(operation: K): typeof codecs[K] {
  if (!Object.hasOwn(codecs, operation)) throw new Error('Turn operation unavailable');
  return codecs[operation];
}
