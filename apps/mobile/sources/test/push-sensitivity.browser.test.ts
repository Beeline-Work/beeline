import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

it.skipIf(!existsSync(CHROME))(
  'shows the three sensitivity levels on phone and desktop in both themes',
  async () => {
    const mobile = process.cwd();
    const out = process.env.PUSH_PROOF_OUT;
    if (out) await mkdir(out, { recursive: true });
    for (const theme of ['obsidian', 'bone']) {
      for (const width of [390, 1200]) {
        const shims = webProofShims(mobile);
        shims['@beeline/api-contract/phone'] =
          `export { PUSH_LEVELS } from '${path.resolve(mobile, '../../packages/api-contract/src/push-level.ts')}';`;
        shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
          'beelineThemes.obsidian',
          `beelineThemes.${theme}`,
        );
        const proof = await runBrowserProof({
          entry: path.join(mobile, 'scripts/push-sensitivity-proof.tsx'),
          mobile,
          shims,
          width,
          height: 900,
          ...(out ? { screenshotPath: path.join(out, `${theme}-${width}.png`) } : {}),
        });
        expect(proof.status, proof.stderr).toBe(0);
        expect(proof.result).toContain('PASS');
        expect(proof.result).toContain('Mentions only');
        expect(proof.result).toContain('My work');
        expect(proof.result).toContain('All activity');
      }
    }
  },
  120_000,
);
