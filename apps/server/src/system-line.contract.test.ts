import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source contract: every system notification is phrased by `system-line.ts`.
 *
 * No other server module may insert a `presentation='system'` row or restate a
 * message's text — a producer that wants a line calls `systemLine` /
 * `restateSystemLine` and says subject, verb, object, consequence.
 */
const sourceDir = fileURLToPath(new URL('.', import.meta.url));
const AUTHORITY = 'system-line.ts';

function serverSources(): string[] {
  return readdirSync(sourceDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== AUTHORITY)
    .sort();
}

/** Every SQL template literal in a source that names the messages table. */
function messageStatements(source: string): string[] {
  return [...source.matchAll(/`[^`]*\b(?:INSERT INTO|UPDATE) messages\b[^`]*`/g)].map(
    (match) => match[0],
  );
}

describe('the one system-line producer', () => {
  it('is the only module that inserts a system line or a card header', () => {
    const offenders = serverSources().flatMap((name) => {
      const statements = messageStatements(readFileSync(`${sourceDir}${name}`, 'utf8'));
      return statements
        .filter((statement) => /INSERT INTO messages/.test(statement))
        .filter((statement) => /'system'|'card'/.test(statement))
        .map((statement) => `${name}: ${statement.replace(/\s+/g, ' ').slice(0, 120)}`);
    });
    expect(offenders).toEqual([]);
  });

  it('is the only module that restates a message text', () => {
    const offenders = serverSources().flatMap((name) => {
      const statements = messageStatements(readFileSync(`${sourceDir}${name}`, 'utf8'));
      return statements
        .filter((statement) => /UPDATE messages SET[^`]*\btext\s*=/.test(statement))
        .map((statement) => `${name}: ${statement.replace(/\s+/g, ' ').slice(0, 120)}`);
    });
    expect(offenders).toEqual([]);
  });

  it('never lets the daemon phrase a system line through postRoomMessage', () => {
    const daemon = readFileSync(`${sourceDir}daemon-service.ts`, 'utf8');
    expect(daemon).toContain("input.presentation === 'card' ? 'card' : 'message'");
    expect(daemon).not.toMatch(/input\.presentation \?\? 'message'/);
  });
});
