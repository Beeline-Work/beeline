import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Room deck creates chat-only Rooms. Repository binding stays on the
 * Room settings surface and cannot become a creation prerequisite.
 */
const source = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');

function blockFrom(text: string, marker: string, label: string): string {
  const start = text.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${label}`);
}

describe('Room creation — chat-first boundary', () => {
  it('creates the Room without a repository prerequisite', () => {
    const handler = blockFrom(
      source,
      'const createRoom = useCallback(async () => {',
      'createRoom',
    );
    const createIndex = handler.indexOf('client.createChannel(');
    expect(createIndex, 'createChannel must run for every Room').toBeGreaterThanOrEqual(0);
    const createCallArgs = handler.slice(createIndex, handler.indexOf(');', createIndex));
    expect(createCallArgs).not.toContain('repository');
    expect(handler).not.toContain('setRoomRepository');
  });

  it('keeps repository controls out of the create dialog', () => {
    const marker = source.indexOf('testID="new-room-dialog"');
    const start = source.lastIndexOf('<HullDialog', marker);
    const end = source.indexOf('</HullDialog>', marker);
    expect(start, 'missing create Room Hull dialog').toBeGreaterThanOrEqual(0);
    expect(end, 'unclosed create Room Hull dialog').toBeGreaterThan(start);
    const panel = source.slice(start, end);
    expect(panel).not.toContain('create-room-repo-row');
    expect(panel).not.toContain('pendingRepo');
  });
});
