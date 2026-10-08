import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = path.join(__dirname, '..');

/** The store loads history; the transport defines the endpoints. Nothing else touches them. */
const ALLOWED = new Set(['buzz/room-message-store.ts', 'sync/transport/room-view-client.ts']);

const HISTORY_CALL = /\.\s*(history|historyAround|historyAfter)\s*\(/;
const HISTORY_PATH = /\/history(\?|['"`]|\$\{)/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [full];
  });
}

describe('Room history boundary', () => {
  it('lets only the Room message store load history', () => {
    const offenders = sourceFiles(sources).flatMap((file) => {
      const relative = path.relative(sources, file).split(path.sep).join('/');
      if (ALLOWED.has(relative)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          HISTORY_CALL.test(line) || HISTORY_PATH.test(line) ? [`${relative}:${index + 1}`] : [],
        );
    });
    expect(offenders).toEqual([]);
  });

  it('catches a component that reads history itself', () => {
    expect(HISTORY_CALL.test('const page = await client.history(roomId, cursor);')).toBe(true);
    expect(HISTORY_CALL.test('void roomClient.historyAround(roomId, id)')).toBe(true);
    expect(HISTORY_PATH.test('`/v1/phone/rooms/${id}/history?after=${messageId}`')).toBe(true);
    expect(HISTORY_CALL.test('router.back(); navigation.goBack()')).toBe(false);
  });
});
