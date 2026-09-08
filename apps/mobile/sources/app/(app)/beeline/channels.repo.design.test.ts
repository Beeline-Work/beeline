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
  it('passes an optional installed repository through the create operation', () => {
    const handler = blockFrom(source, 'const createRoom = useCallback(async () => {', 'createRoom');
    const createIndex = handler.indexOf('transport.createRoom(');
    expect(createIndex, 'transport create must run for every Room').toBeGreaterThanOrEqual(0);
    const createCallArgs = handler.slice(createIndex, handler.indexOf(');', createIndex));
    expect(createCallArgs).toContain('repository: pendingRepo ?? undefined');
    expect(handler).not.toContain('!pendingRepo');
    expect(handler).not.toContain('setRoomRepository');
  });

  it('forwards the production installation groups that own repository candidates', () => {
    const loader = blockFrom(source, 'const loadRepoPicker = useCallback(', 'loadRepoPicker');
    expect(loader).toContain('transport.workspaceGitHubAccess({ refresh })');
    expect(loader).toContain('setRepoCandidates(access.candidates)');
    expect(loader).toContain('setRepoInstallations(access.installations)');
  });

});
