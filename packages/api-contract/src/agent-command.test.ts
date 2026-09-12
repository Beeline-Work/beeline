import { describe, expect, it } from 'vitest';
import { isAgentCommand } from './daemon-operations.js';
const command = {
  id: 'command',
  roomId: 'room',
  agentId: 'agent',
  sourceMessageId: 'message',
  turnRequestId: 'turn',
  rootCommandId: 'root',
  rootSourceMessageId: 'human',
  reason: 'human_tag',
  action: 'input',
  agentDepth: 0,
  source: {
    id: 'message',
    authorId: 'human',
    body: 'Work',
    createdAt: 1,
    attachments: [],
  },
};
describe('server command protocol 1', () => {
  it.each(['input', 'resume', 'stop'])('recognizes %s', (action) =>
    expect(isAgentCommand({ ...command, action })).toBe(true),
  );
  it.each([
    undefined,
    null,
    {},
    { ...command, action: 'message' },
    { ...command, agentDepth: -1 },
    { ...command, agentDepth: 4 },
    { ...command, source: {} },
    { ...command, agentId: '' },
  ])('rejects malformed command %#', (value) => expect(isAgentCommand(value)).toBe(false));
});
