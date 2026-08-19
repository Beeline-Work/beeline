import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source assertions for the optional repo step in Room creation — same
 * technique as `channels.design.test.ts`: no render harness for this screen,
 * so the structural guarantee (repo is opt-in, never blocks a chat-only Room)
 * is checked as text.
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

/** Same idea, but for a JSX `{cond && (...)}` block whose top-level nesting is parens. */
function parenBlockFrom(text: string, marker: string, label: string): string {
  const start = text.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('(', start); index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${label}`);
}

describe('Room creation — optional repo step', () => {
  it('creates the Room unconditionally, and only links a repo when one was picked', () => {
    const handler = blockFrom(
      source,
      'const handleCreateChannel = useCallback(async () => {',
      'handleCreateChannel',
    );
    const createIndex = handler.indexOf('client.createChannel(');
    const guardIndex = handler.indexOf('if (pendingRepo?.remote) {');
    const setRepoIndex = handler.indexOf('client.setRoomRepository(');
    expect(createIndex, 'createChannel must run for every Room').toBeGreaterThanOrEqual(0);
    expect(guardIndex, 'repo binding must be gated on a picked repo').toBeGreaterThan(createIndex);
    expect(setRepoIndex).toBeGreaterThan(guardIndex);
    // createChannel itself must not carry a repository option — the picker
    // always writes through the mutable setRoomRepository path, never the
    // immutable genesis binding, so the same write path is used whether the
    // repo is picked at creation time or later from Room settings.
    const createCallArgs = handler.slice(createIndex, handler.indexOf(');', createIndex));
    expect(createCallArgs).not.toContain('repository');
  });

  it('renders the repo row inside the create panel, defaulting to none', () => {
    const panel = parenBlockFrom(source, 'showCreateChannel && !viewerIsAgent && (', 'create Room panel');
    expect(panel).toContain('testID="create-room-repo-row"');
    expect(panel).toContain("pendingRepo ? `▢ ${pendingRepo.name}` : 'none");
  });
});
