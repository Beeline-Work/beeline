import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('the @Wallet DM in a browser', () => {
  const mobile = process.cwd();
  const base = webProofShims(mobile);

  it('pads the permission card evenly, draws the Coinbase Wallet mark, and names an agent DM', async () => {
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/wallet-dm-proof.tsx'),
      mobile,
      shims: {
        ...base,
        // TranscriptCard's settle motion, at rest.
        'react-native-reanimated': `${base['react-native-reanimated']}
          export const FadeOut = entering;
          export const interpolateColor = (_value, _input, output) => output[output.length - 1];`,
        'proof:wallet-svg': `export default ${JSON.stringify(
          readFileSync(path.join(mobile, '../server/assets/connectors/wallet.svg'), 'utf8'),
        )};`,
      },
      width: 390,
    });
    expect(status, stderr).toBe(0);
    expect(result).toContain('PASS');
    const [, top, bottom] = result.match(/card top (\d+)px bottom (\d+)px/) ?? [];
    expect(Math.abs(Number(top) - Number(bottom)), result).toBeLessThanOrEqual(2);
    // Header and card: Coinbase Wallet's blue ground and its white ring around a
    // rounded square (wallet-sdk's own mark), not a bar-cut "C".
    expect(result).toContain('logos #0052ff+M152 512,#0052ff+M152 512');
    expect(result).toContain('agent meta claude-opus-5-5 · @lunchboxfortwo');
  }, 90_000);
});
