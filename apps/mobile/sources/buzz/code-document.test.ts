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
});
