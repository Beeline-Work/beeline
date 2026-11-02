import { expect, it } from 'vitest';
import { helperTurnCodecs } from './helper-turn-codecs.js';

it('restricts turn controls to closed claim/receipt/ack inputs and validates replies', () => {
  expect(() => helperTurnCodecs('postRoomMessage' as never)).toThrow('unavailable');
  const input = { roomId: 'room', commandId: 'command', generationId: 'generation' };
  expect(helperTurnCodecs('claimAgentCommand').params.parse(input)).toEqual(input);
  expect(helperTurnCodecs('acknowledgeAgentCommand').params.parse(input)).toEqual(input);
  expect(() => helperTurnCodecs('claimAgentCommand').params.parse({ ...input, source: { connectionId: 'forged', epoch: 1 } })).toThrow();
  expect(() => helperTurnCodecs('postAgentTurnReceipt').params.parse({
    roomId: 'room', agentId: 'agent', requestId: 'request', status: 'working', pass: 'forged',
  })).toThrow();
  expect(() => helperTurnCodecs('postAgentTurnReceipt').result.parse({ status: 'not-a-write-result' })).toThrow();
  let getterCalls = 0;
  expect(() => helperTurnCodecs('claimAgentCommand').params.parse({ ...input,
    get arbitrary() { getterCalls += 1; return 'forged'; },
  })).toThrow();
  expect(getterCalls).toBe(0);
});

it('allows only the bounded closed owned-model credential on a claim result and retains absent-field compatibility', () => {
  const codec = helperTurnCodecs('claimAgentCommand').result;
  const write = { id: 'synthetic-result', createdAt: 1_800_000_000 };
  const modelCredential = { v: 1, token: `bfmc_v1.${'a'.repeat(32)}.${'b'.repeat(64)}`, expiresAt: 1_800_000_001 };
  expect(codec.parse(write)).toEqual(write);
  expect(codec.parse({ ...write, modelCredential })).toEqual({ ...write, modelCredential });
  for (const credential of [{ ...modelCredential, token: 'bfm_legacy' }, { ...modelCredential, token: modelCredential.token + '.extra' },
    { ...modelCredential, v: 2 }, { ...modelCredential, providerKey: 'synthetic-secret' },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity].map(expiresAt => ({ ...modelCredential, expiresAt }))])
    expect(() => codec.parse({ ...write, modelCredential: credential })).toThrow();
});

it('rejects credential getters without executing or serializing secret values', () => {
  let calls = 0;
  const modelCredential = { v: 1, expiresAt: 1_800_000_001, get token() { calls++; return 'synthetic-secret'; } };
  expect(() => helperTurnCodecs('claimAgentCommand').result.parse({ id: 'synthetic', createdAt: 1_800_000_000, modelCredential })).toThrow();
  expect(calls).toBe(0);
});
