
import { describe as move7_describe, expect as move7_expect, it as move7_it } from 'vitest';

import { isAgentCommand as move7_isAgentCommand } from "./daemon-operations.js";
import { describe as movedDescribe7 } from 'vitest';
movedDescribe7("agent-command.test.ts", () => {

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

move7_describe('server command protocol 1', () => {
  move7_it.each(['input', 'resume', 'stop'])('recognizes %s', (action) =>
    move7_expect(move7_isAgentCommand({ ...command, action })).toBe(true),
  );
  move7_it.each([
    undefined,
    null,
    {},
    { ...command, action: 'message' },
    { ...command, agentDepth: -1 },
    { ...command, agentDepth: 4 },
    { ...command, source: {} },
    { ...command, agentId: '' },
  ])('rejects malformed command %#', (value) => move7_expect(move7_isAgentCommand(value)).toBe(false));
});
});
