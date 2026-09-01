import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('Room creation — repository binding', () => {
  it('passes the selected installed repository through the create operation', () => {
    const handler = blockFrom(
      source,
      'const createRoom = useCallback(async () => {',
      'createRoom',
    );
    const createIndex = handler.indexOf('transport.createRoom(');
    expect(createIndex, 'transport create must run for every Room').toBeGreaterThanOrEqual(0);
    const createCallArgs = handler.slice(createIndex, handler.indexOf(');', createIndex));
    expect(createCallArgs).toContain('repository: pendingRepo');
    expect(handler).not.toContain('setRoomRepository');
  });

  it('requires and renders the searchable repository picker in the create dialog', () => {
    const marker = source.indexOf('testID="new-room-dialog"');
    const start = source.lastIndexOf('<HullDialog', marker);
    const end = source.indexOf('</HullDialog>', marker);
    expect(start, 'missing create Room Hull dialog').toBeGreaterThanOrEqual(0);
    expect(end, 'unclosed create Room Hull dialog').toBeGreaterThan(start);
    const panel = source.slice(start, end);
    expect(panel).toContain('create-room-repo-row');
    expect(panel).toContain('<RepoPicker');
    expect(panel).toContain('currentKey={pendingRepo?.key ?? null}');
    expect(panel).toContain('disabled: !roomName.trim() || !pendingRepo || creatingRoom');
  });
});
