import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * New Room's Repository field, painted in Chrome and walked the way a
 * person does. Each line is what the dialog showed after one tap — the
 * counterpart to `RoomRepositoryChoice.browser.test.ts`.
 */
function proof(query: string) {
  const mobile = process.cwd();
  return runBrowserProof({
    entry: path.join(mobile, 'scripts/new-room-repo-choice-proof.tsx'),
    mobile,
    shims: webProofShims(mobile),
    width: 390,
    height: 844,
    query,
  });
}

describe.skipIf(!existsSync(CHROME))('New Room Repository field in the browser', () => {
  it('reveals the switch on tap and creates a repo under the chosen owner', async () => {
    const { result, status, stderr } = await proof('');
    console.log(result);
    expect(status, stderr).toBe(0);
    const lines = result.split('\n');
    expect(lines[0]).toBe('N1: New Room Repository None Public Cancel Create Room');
    expect(lines[1]).toBe(
      'N2: New Room Repository None Link Create Public Cancel Create Room',
    );
    expect(lines[2]).toBe(
      'N3: New Room Repository None Link Create trusty-squire thecollector Public Cancel Create Room',
    );
    expect(lines[3]).toContain('trusty-squire ✓ Beeline-Work Connect another org');
    expect(result).toContain('saved: nothing');
    expect(result).toContain('console errors: none');
  }, 90_000);
});
