import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The Room header sheet's Repository control, painted in Chrome and walked the
 * way a person does. Each line is what the sheet showed after one tap.
 */
function proof(query: string) {
  const mobile = process.cwd();
  return runBrowserProof({
    entry: path.join(mobile, 'scripts/room-repo-choice-proof.tsx'),
    mobile,
    shims: webProofShims(mobile),
    width: 390,
    height: 844,
    query,
  });
}

describe.skipIf(!existsSync(CHROME))('Room header Repository control in the browser', () => {
  it('links a picked repo and creates one named after the Room, only on Save', async () => {
    const { result, status, stderr } = await proof('');
    console.log(result);
    expect(status, stderr).toBe(0);
    const lines = result.split('\n');
    expect(lines[0]).toBe('H1: #thecollector Repository None Cancel Save');
    expect(lines[1]).toBe('H2: #thecollector Repository None Link Create Cancel Save');
    expect(lines[2]).toBe(
      'H3: #thecollector Repository None Link Create Choose a repo Cancel Save',
    );
    expect(lines[3]).toBe(
      'H4: Choose a repo TRUSTY-SQUIRE trusty-squire castellan trusty-squire-housekeeper veritaserum goodser Back',
    );
    expect(lines[4]).toBe('H4-search: Search repos');
    expect(lines[5]).toBe(
      'H3-picked: #thecollector Repository None Link Create trusty-squire castellan Cancel Save',
    );
    expect(lines[7]).toBe(
      'H5: #thecollector Repository None Link Create trusty-squire thecollector Cancel Save',
    );
    expect(lines[8]).toContain('trusty-squire ✓ Beeline-Work Connect another org');
    expect(result).toContain('saved: link trusty-squire/castellan | create 1 thecollector');
    expect(result).toContain('console errors: none');
  }, 90_000);

  it('unlinks a linked repo with None + Save', async () => {
    const { result, status, stderr } = await proof('?linked=1');
    console.log(result);
    expect(status, stderr).toBe(0);
    expect(result).toContain('H9: #thecollector Repository castellan Cancel Save');
    expect(result).toContain('saved: unlink');
  }, 90_000);
});
