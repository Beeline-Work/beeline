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
