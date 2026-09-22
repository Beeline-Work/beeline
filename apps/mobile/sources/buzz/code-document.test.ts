import { describe, expect, it } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import { codeDocumentFromMessages } from './code-document';

const message = {
  id: 'message-42',
  text: [
    'before',
    '```ts',
    'const first = 1;',
    '```',
    'between',
    '```json',
    '{"second":2}',
    '```',
  ].join('\n'),
  author: { pubkey: 'person', kind: 'human', name: 'Person' },
  createdAt: 1,
  presentation: 'message',
} as RoomViewMessage;

describe('codeDocumentFromMessages', () => {
  it('resolves a code-block ordinal from the exact Room message', () => {
    expect(codeDocumentFromMessages([message], 'message-42', 1)).toMatchObject({
      type: 'code',
      title: 'json',
      language: 'json',
      code: '{"second":2}',
    });
  });

  it('fails closed for a different message or block', () => {
    expect(codeDocumentFromMessages([message], 'another-message', 0)).toBeNull();
    expect(codeDocumentFromMessages([message], 'message-42', 2)).toBeNull();
    expect(codeDocumentFromMessages([message], 'message-42', -1)).toBeNull();
  });

  it('resolves the JSON fence synthesized for a multiline agent message', () => {
    const json = [
      '{',
      '  "result": {',
      '    "status": "ok",',
      '    "items": [1, 2]',
      '  }',
      '}',
    ].join('\n');
    const agentMessage = {
      id: 'agent-json',
      text: json,
      author: { pubkey: 'agent', kind: 'agent', name: 'Agent' },
      createdAt: 2,
      presentation: 'message',
    } as RoomViewMessage;

    expect(codeDocumentFromMessages([agentMessage], 'agent-json', 0)).toMatchObject({
      type: 'code',
      title: 'json',
      language: 'json',
      code: json,
    });
  });

  it('does not synthesize a code block for a human JSON message', () => {
    const humanMessage = {
      id: 'human-json',
      text: '{\n  "status": "ok"\n}',
      author: { pubkey: 'person', kind: 'human', name: 'Person' },
      createdAt: 3,
      presentation: 'message',
    } as RoomViewMessage;

    expect(codeDocumentFromMessages([humanMessage], 'human-json', 0)).toBeNull();
  });
});
