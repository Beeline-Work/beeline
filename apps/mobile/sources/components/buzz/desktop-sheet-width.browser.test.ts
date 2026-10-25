import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('Desktop sheet width and scrolling', () => {
  for (const width of [500, 1280, 1440, 1920]) {
    it(`opens the real sheet at ${width}px`, async () => {
      const mobile = process.cwd();
      const evidence = process.env.DESKTOP_WIDTH_EVIDENCE;
      if (evidence) mkdirSync(evidence, { recursive: true });
      const shims = webProofShims(mobile);
      const phase = 'after';
      const proof = await runBrowserProof({
        mobile, width, height: 900,
        entry: path.join(mobile, 'scripts/desktop-sheet-width-proof.tsx'),
        shims,
        screenshotPath: evidence ? path.join(evidence, `${phase}-${width}.png`) : undefined,
      });
      expect(proof.status, proof.stderr).toBe(0);
      const result = JSON.parse(proof.result);
      if (evidence) writeFileSync(path.join(evidence, `${phase}-${width}.json`), JSON.stringify(result, null, 2) + '\n');
      expect(result.centred).toBe(true);
      if (width >= 768) {
        expect(result.width).toBe(560);
        expect(result.height).toBeLessThanOrEqual(result.windowHeight * 0.82 + 1);
        expect(result.bodyScrolls).toBe(true);
        expect(result.bodyInside).toBe(true);
      } else {
        expect(result.width).toBe(width);
      }
    }, 90_000);
  }
});
